"""Sync extension source trees into publoader's runtime extensions dir.

Reads each `<source>/src/<extension>/` subtree and atomically replaces
`<target>/src/<extension>/`. `schedule*.json` files at the source root are
copied to `<target>/` so `_open_json_timings` (which globs at that level)
picks them up.

Replaces the dedicated sidecar containers — publoader's entrypoint runs this
script once per bind-mounted source repo, then starts. Importable too so
`/refresh` over IPC can re-sync without restarting the container.

CLI:
    python sync_extensions.py [SOURCE ...]

Sources fall back to the PUBLOADER_SOURCE env var, then to /sources/*/.
Target defaults to /app/publoader/extensions; override via PUBLOADER_TARGET.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Iterable

DEFAULT_TARGET = Path("/app/publoader/extensions")
SCANNED_SOURCE_ROOT = Path("/sources")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s sync_extensions: %(message)s",
)
log = logging.getLogger("sync_extensions")


def _target_dir() -> Path:
    return Path(os.environ.get("PUBLOADER_TARGET", str(DEFAULT_TARGET)))


def _is_valid_extension_name(name: str) -> bool:
    return bool(name) and all(c.islower() or c.isdigit() or c == "_" for c in name)


def _atomic_replace_tree(src: Path, dst: Path) -> None:
    """Replace `dst` with a copy of `src` atomically (same filesystem)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{dst.name}.", dir=dst.parent))
    try:
        shutil.copytree(src, staging / dst.name, dirs_exist_ok=False)
        backup = None
        if dst.exists():
            backup = dst.with_suffix(dst.suffix + ".old")
            if backup.exists():
                shutil.rmtree(backup)
            dst.rename(backup)
        (staging / dst.name).rename(dst)
        if backup is not None:
            shutil.rmtree(backup, ignore_errors=True)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _validate_extension(ext_dir: Path) -> bool:
    name = ext_dir.name
    if not _is_valid_extension_name(name):
        log.error("skip %s: invalid extension name", name)
        return False
    if not (ext_dir / f"{name}.py").is_file():
        log.error("skip %s: missing %s.py", name, name)
        return False
    manifest_path = ext_dir / "manifest.json"
    if not manifest_path.is_file():
        log.error("skip %s: missing manifest.json", name)
        return False
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, ValueError) as exc:
        log.error("skip %s: manifest.json invalid (%s)", name, exc)
        return False
    if manifest.get("name") != name:
        log.error(
            "skip %s: manifest.name=%r doesn't match directory",
            name,
            manifest.get("name"),
        )
        return False
    return True


def sync_source(source_root: Path, target_dir: Path | None = None) -> dict:
    """Sync a single source repo's extensions into `target_dir/src/`.

    Returns a dict with `ok`, `source`, `target`, `synced`, `skipped`.
    """
    target_dir = target_dir or _target_dir()
    source_src = source_root / "src"
    if not source_src.is_dir():
        log.warning("source missing: %s", source_src)
        return {
            "ok": False,
            "source": str(source_root),
            "target": str(target_dir),
            "error": f"no src/ under {source_root}",
            "synced": [],
            "skipped": [],
        }

    ext_target = target_dir / "src"
    ext_target.mkdir(parents=True, exist_ok=True)
    synced: list = []
    skipped: list = []

    for child in sorted(source_src.iterdir()):
        if not child.is_dir() or child.name.startswith((".", "__")):
            continue
        if not _validate_extension(child):
            skipped.append(child.name)
            continue
        try:
            _atomic_replace_tree(child, ext_target / child.name)
            synced.append(child.name)
        except OSError as exc:
            log.exception("failed syncing %s: %s", child.name, exc)
            skipped.append(child.name)

    target_dir.mkdir(parents=True, exist_ok=True)
    for schedule_file in sorted(source_root.glob("schedule*.json")):
        try:
            shutil.copy2(schedule_file, target_dir / schedule_file.name)
        except OSError as exc:
            log.exception("failed copying %s: %s", schedule_file.name, exc)

    log.info(
        "synced source=%s synced=%s skipped=%s target=%s",
        source_root,
        synced,
        skipped,
        target_dir,
    )
    return {
        "ok": not skipped,
        "source": str(source_root),
        "target": str(target_dir),
        "synced": synced,
        "skipped": skipped,
    }


def _resolve_sources(args: list[str]) -> list[Path]:
    if args:
        return [Path(a) for a in args]
    env = os.environ.get("PUBLOADER_SOURCE")
    if env:
        return [Path(p) for p in env.split(os.pathsep) if p]
    if SCANNED_SOURCE_ROOT.is_dir():
        return sorted(p for p in SCANNED_SOURCE_ROOT.iterdir() if p.is_dir())
    return []


def sync_all(sources: Iterable[Path], target_dir: Path | None = None) -> list[dict]:
    results = []
    for src in sources:
        results.append(sync_source(src, target_dir))
    return results


def main(argv: list[str] | None = None) -> int:
    args = list(argv if argv is not None else sys.argv[1:])
    sources = _resolve_sources(args)
    if not sources:
        log.warning("no sources to sync (no args, PUBLOADER_SOURCE, or /sources/)")
        return 0
    results = sync_all(sources)
    return 0 if all(r.get("ok") for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
