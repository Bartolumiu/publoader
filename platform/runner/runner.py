#!/usr/bin/env python3
"""Execute one extension job and print a JSON result envelope.

This shim holds no coordination logic. It receives a fully-specified job from
the worker agent, drives the extension's Python contract exactly as the
monolith's ``run_extension`` does, and prints one JSON object as the last line
of stdout. Scheduling, retries, leases, deduplication and uploading all stay in
the control plane.

Protocol (worker agent -> runner), ``--job <file>``::

    {"jobId": str, "runId": str, "extension": str, "extensionVersion": str,
     "bundleSha256": str, "kind": "SCHEDULED"|"CLEAN"|"MANUAL", "attempt": int,
     "segmentIndex": int|null, "segmentTotal": int|null, "segmentKey": str|null,
     "segmentMangaIds": [str], "postedChapterIds": [str],
     "manifest": {...}|null, "timeoutSeconds": int}

Protocol (runner -> worker agent), last line of stdout::

    {"runnerVersion": 1, "status": "ok"|"error",
     "error": {"class": "TRANSIENT"|"PERMANENT", "message": str}|null,
     "updatedChapters": [ChapterRecord], "allChapters": [ChapterRecord]|null,
     "untrackedManga": [MangaRecord], "trackedMangadexIds": [str],
     "mangadexGroupId": str|null, "overrideOptions": {...},
     "extensionLanguages": [str],
     "images": [{"listName": "updatedChapters"|"allChapters",
                 "chapterIndex": int, "files": [absolute path]}],
     "stats": {"durationS": float}}

Chapter images travel as files under ``--output`` rather than inside the JSON;
the agent uploads each one as a checksummed artifact and fills in the matching
``imageArtifacts`` before submitting the envelope. Exit status is 0 whenever an
envelope was printed, including for extension failures — a failed run is a
result, not a crash.
"""

import argparse
import importlib.util
import json
import os
import re
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

RUNNER_VERSION = 1
EXTENSION_NAME_REGEX = re.compile(r"^([a-z0-9_]+)$")


class ContractError(Exception):
    """The bundle does not satisfy the extension contract. Never retryable."""


# --------------------------------------------------------------------------
# stdout protection
# --------------------------------------------------------------------------
# Extensions print freely (the monolith ran them attached to a console), and
# some pull in libraries that write to fd 1 below Python's buffering. stdout
# here is a structured channel, so fd 1 is redirected to stderr for the whole
# run and the envelope is written to a duplicate of the original.


def _capture_stdout() -> int:
    saved = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return saved


def _emit(saved_fd: int, payload: Dict[str, Any]) -> None:
    with os.fdopen(saved_fd, "w", encoding="utf-8") as out:
        out.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        out.write("\n")
        out.flush()


# --------------------------------------------------------------------------
# contract helpers (mirrors of publoader.load_extensions)
# --------------------------------------------------------------------------


def _log(message: str) -> None:
    print("runner: " + message, file=sys.stderr, flush=True)


def call_method(extension, method: str, default=None, *args, **kwargs):
    """Call ``method`` if the extension defines it, else return ``default``."""
    bound = getattr(extension, method, None)
    if bound is None or not callable(bound):
        _log(f"extension has no {method}() method; using default")
        return default
    return bound(*args, **kwargs)


def validate_list(values, element_type, return_none: bool = False):
    """Mirror of load_extensions.validate_list_chapters."""
    if return_none:
        return None
    if not isinstance(values, list):
        raise TypeError("Specified list is not a list.")
    correct = [item for item in values if isinstance(item, element_type)]
    wrong = len(values) - len(correct)
    if wrong:
        _log(f"dropped {wrong} element(s) of the wrong type")
    return correct


def to_utc(value) -> Optional[datetime]:
    if value is None:
        return None
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        # The monolith's convert_chapters_datetimes leans on the host's local
        # zone here; workers may sit anywhere, so naive values are read as UTC.
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def iso(value) -> Optional[str]:
    moment = to_utc(value)
    if moment is None:
        return None
    return moment.replace(microsecond=(moment.microsecond // 1000) * 1000).isoformat()


def as_str(value) -> Optional[str]:
    return None if value is None else str(value)


def chapter_to_record(chapter) -> Dict[str, Any]:
    """Convert a Chapter dataclass to the camelCase wire shape in records.ts."""
    return {
        "chapterLookup": iso(chapter.chapter_lookup),
        "chapterTimestamp": iso(chapter.chapter_timestamp),
        "chapterExpire": iso(chapter.chapter_expire),
        "chapterLanguage": as_str(chapter.chapter_language),
        "chapterNumber": as_str(chapter.chapter_number),
        "chapterTitle": as_str(chapter.chapter_title),
        "chapterVolume": as_str(chapter.chapter_volume),
        "chapterId": as_str(chapter.chapter_id),
        "chapterUrl": as_str(chapter.chapter_url),
        "mdChapterId": as_str(chapter.md_chapter_id),
        "mangaId": as_str(chapter.manga_id),
        "mdMangaId": as_str(chapter.md_manga_id),
        "mdGroupId": as_str(chapter.md_group_id),
        "mangaName": as_str(chapter.manga_name),
        "mangaUrl": as_str(chapter.manga_url),
        "extensionName": as_str(chapter.extension_name),
        "imageArtifacts": [],
    }


def manga_to_record(manga) -> Dict[str, Any]:
    return {
        "mangaId": str(manga.manga_id),
        "mangaName": str(manga.manga_name),
        "mangaLanguage": str(manga.manga_language),
        "mangaUrl": str(manga.manga_url),
    }


_IMAGE_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"\xff\xd8\xff", ".jpg"),
    (b"GIF87a", ".gif"),
    (b"GIF89a", ".gif"),
)


def image_suffix(data: bytes) -> str:
    """Name page files by what they actually are.

    The agent maps the suffix to a content type and the core only accepts
    png/jpeg/gif/webp, so a mislabelled page would be rejected on upload. The
    monolith never had to care because bytes went straight into a zip.
    """
    for signature, suffix in _IMAGE_SIGNATURES:
        if data.startswith(signature):
            return suffix
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return ".bin"


def write_images(
    output_dir: Path, list_name: str, index: int, images: Sequence[bytes]
) -> List[str]:
    target = output_dir.joinpath("images", list_name, str(index))
    target.mkdir(parents=True, exist_ok=True)
    written: List[str] = []
    for page, data in enumerate(images):
        if not isinstance(data, (bytes, bytearray)):
            _log(f"{list_name}[{index}] page {page} is not bytes; skipping")
            continue
        payload = bytes(data)
        path = target.joinpath(f"{page:04d}{image_suffix(payload)}")
        path.write_bytes(payload)
        written.append(str(path))
    return written


# --------------------------------------------------------------------------
# extension loading
# --------------------------------------------------------------------------


def load_extension(bundle_dir: Path, manifest: Dict[str, Any]):
    """Import the bundle's entrypoint and instantiate its Extension class.

    Mirrors load_extensions.load_extension's import strategy (module named
    ``extensions.<name>`` loaded from an explicit file path) so relative
    behaviour inside extensions is unchanged. The monolith's AST safety scan is
    not repeated here — it is a publish-time gate in the bundle pipeline, and
    re-running it on the worker would only re-check what the sha256 pin already
    guarantees.
    """
    name = str(manifest.get("name") or bundle_dir.name)
    if not EXTENSION_NAME_REGEX.match(name):
        raise ContractError(f"{name!r} does not match {EXTENSION_NAME_REGEX.pattern}")

    entrypoint = str(manifest.get("entrypoint") or f"{name}.py")
    mainfile = bundle_dir.joinpath(entrypoint)
    if not mainfile.is_file():
        raise ContractError(f"entrypoint {entrypoint} missing from bundle")

    module_name = f"extensions.{name}"
    spec = importlib.util.spec_from_file_location(module_name, mainfile)
    if spec is None or spec.loader is None:
        raise ContractError(f"could not build an import spec for {entrypoint}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)

    class_name = str(manifest.get("class_name") or "Extension")
    extension_class = getattr(module, class_name, None)
    if extension_class is None:
        raise ContractError(f"{entrypoint} has no {class_name} class")
    return extension_class(Path(bundle_dir)), name


# --------------------------------------------------------------------------
# the run
# --------------------------------------------------------------------------


def run_job(extension, job: Dict[str, Any], output_dir: Path) -> Dict[str, Any]:
    clean_db = str(job.get("kind") or "").upper() == "CLEAN"
    segment_ids = {str(x) for x in (job.get("segmentMangaIds") or [])}

    if segment_ids:
        subset = getattr(extension, "set_tracked_subset", None)
        if callable(subset):
            _log(f"narrowing fetch to {len(segment_ids)} tracked manga")
            subset(sorted(segment_ids))
        else:
            _log("extension has no set_tracked_subset(); filtering results instead")

    posted_chapter_ids = [] if clean_db else [
        str(x) for x in (job.get("postedChapterIds") or [])
    ]
    update_external = getattr(extension, "update_external_data", None)
    if callable(update_external):
        update_external(posted_chapter_ids, clean_db)
    else:
        _log("extension has no update_external_data() method")

    updated_chapters = call_method(extension, "get_updated_chapters", default=[])
    all_chapters = call_method(extension, "get_all_chapters", default=None)
    untracked_manga = call_method(extension, "get_updated_manga", default=[])

    tracked_mangadex_ids = getattr(extension, "tracked_mangadex_ids", None) or []
    mangadex_group_id = getattr(extension, "mangadex_group_id", None)
    override_options = getattr(extension, "override_options", None)
    extension_languages = getattr(extension, "extension_languages", None) or []

    from publoader.models.dataclasses import Chapter, Manga

    updated_chapters = validate_list(updated_chapters, Chapter)
    # all_chapters is only meaningful on a clean run; the core treats its
    # absence as "no removal information", never as "everything is gone".
    try:
        all_chapters = validate_list(all_chapters, Chapter, return_none=not clean_db)
    except TypeError:
        _log("get_all_chapters() did not return a list; treating as absent")
        all_chapters = None

    try:
        untracked_manga = validate_list(untracked_manga, Manga)
    except TypeError:
        _log("get_updated_manga() did not return a list; treating as empty")
        untracked_manga = []

    tracked_mangadex_ids = validate_list(tracked_mangadex_ids, str)
    extension_languages = validate_list(extension_languages, str)

    if not isinstance(override_options, dict):
        if override_options is not None:
            _log("override_options is not a dict; using an empty one")
        override_options = {}

    # Filter to the segment unconditionally, whether or not the extension
    # honoured set_tracked_subset. Non-overlapping segment output is then a
    # property of the runner, not of extension cooperation.
    if segment_ids:
        before = len(updated_chapters)
        updated_chapters = [
            c for c in updated_chapters if str(c.manga_id) in segment_ids
        ]
        _log(f"segment filter kept {len(updated_chapters)}/{before} updated chapters")
        if all_chapters is not None:
            all_chapters = [c for c in all_chapters if str(c.manga_id) in segment_ids]

    updated_records = [chapter_to_record(c) for c in updated_chapters]
    all_records = (
        None if all_chapters is None else [chapter_to_record(c) for c in all_chapters]
    )

    images: List[Dict[str, Any]] = []
    for index, chapter in enumerate(updated_chapters):
        if chapter.images:
            files = write_images(output_dir, "updatedChapters", index, chapter.images)
            if files:
                images.append(
                    {
                        "listName": "updatedChapters",
                        "chapterIndex": index,
                        "files": files,
                    }
                )
    if all_chapters is not None:
        for index, chapter in enumerate(all_chapters):
            if chapter.images:
                files = write_images(output_dir, "allChapters", index, chapter.images)
                if files:
                    images.append(
                        {
                            "listName": "allChapters",
                            "chapterIndex": index,
                            "files": files,
                        }
                    )

    return {
        "updatedChapters": updated_records,
        "allChapters": all_records,
        # Untracked manga are deliberately NOT segment-filtered: they are
        # series with no mapping yet, so they belong to no segment, and
        # dropping them would hide new titles from the operator. The core
        # dedupes by manga id across a run's segments.
        "untrackedManga": [manga_to_record(m) for m in untracked_manga],
        "trackedMangadexIds": [str(x) for x in tracked_mangadex_ids],
        "mangadexGroupId": as_str(mangadex_group_id),
        "overrideOptions": override_options,
        "extensionLanguages": [str(x) for x in extension_languages],
        "images": images,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Execute one publoader extension job.")
    parser.add_argument("--bundle", required=True, help="extracted extension bundle dir")
    parser.add_argument("--job", required=True, help="job.json describing the work")
    parser.add_argument("--output", required=True, help="scratch dir for page images")
    args = parser.parse_args()

    saved_stdout = _capture_stdout()
    started = time.monotonic()
    phase = "setup"

    try:
        bundle_dir = Path(args.bundle).resolve(strict=True)
        output_dir = Path(args.output).resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        with open(args.job, "r", encoding="utf-8") as fp:
            job = json.load(fp)

        # The compat publoader package must shadow anything the bundle ships,
        # and both must precede whatever else is installed on the worker.
        runner_dir = Path(__file__).resolve().parent
        sys.path.insert(0, str(bundle_dir))
        sys.path.insert(0, str(runner_dir))

        manifest = job.get("manifest") or {}
        allowed_hosts = manifest.get("allowed_hosts") or []
        if not allowed_hosts:
            raise ContractError("manifest declares no allowed_hosts")

        # Installed before the extension is imported: libraries that capture
        # socket.getaddrinfo at import time must capture the guarded one.
        from hostguard import install_allowlist

        install_allowlist(allowed_hosts)

        from publoader.utils import utils as compat_utils

        compat_utils.set_bundle_dir(bundle_dir)

        # Import failures — a missing dependency, a syntax error, a bundle
        # whose entrypoint does not match its manifest — are properties of the
        # bundle, so retrying the same pinned sha256 would fail identically.
        phase = "import"
        extension, name = load_extension(bundle_dir, manifest)
        _log(f"loaded extensions.{name}")

        phase = "run"
        result = run_job(extension, job, output_dir)
    except ContractError as err:
        traceback.print_exc()
        _emit(
            saved_stdout,
            _error_envelope("PERMANENT", f"{type(err).__name__}: {err}", started),
        )
        return 0
    except BaseException as err:  # noqa: BLE001 - a failed run is still a result
        traceback.print_exc()
        # Setup and import failures are the bundle or manifest being wrong,
        # which retrying the same pinned bundle cannot fix; a failure once the
        # extension is running is usually the upstream site, which it can.
        err_class = "TRANSIENT" if phase == "run" else "PERMANENT"
        _emit(
            saved_stdout,
            _error_envelope(err_class, f"{type(err).__name__}: {err}", started),
        )
        return 0

    envelope = {
        "runnerVersion": RUNNER_VERSION,
        "status": "ok",
        "error": None,
        "stats": {"durationS": round(time.monotonic() - started, 3)},
    }
    envelope.update(result)
    _emit(saved_stdout, envelope)
    return 0


def _error_envelope(err_class: str, message: str, started: float) -> Dict[str, Any]:
    return {
        "runnerVersion": RUNNER_VERSION,
        "status": "error",
        "error": {"class": err_class, "message": message[:10000]},
        "updatedChapters": [],
        "allChapters": None,
        "untrackedManga": [],
        "trackedMangadexIds": [],
        "mangadexGroupId": None,
        "overrideOptions": {},
        "extensionLanguages": [],
        "images": [],
        "stats": {"durationS": round(time.monotonic() - started, 3)},
    }


if __name__ == "__main__":
    sys.exit(main())
