"""Pure helpers extensions import from ``publoader.utils.utils``.

Only the side-effect-free parts of the monolith's module are vendored. The
functions that reach MangaDex or write bot state stay behind: a worker has no
MangaDex credentials and no canonical state to write.

Paths given to the ``open_*`` helpers are resolved against the extension bundle
when relative, so a bundle is self-contained no matter what the runner's cwd is.
"""

import datetime
import errno
import json
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Dict, Optional, Union

logger = logging.getLogger("publoader")

#: Set by the runner to the extracted bundle directory before the extension is
#: imported. Extensions that build paths from ``root_path`` land inside their
#: own bundle rather than the worker's filesystem root.
root_path = Path(".")

_bundle_dir: Optional[Path] = None
_platform_manga_id_map: Optional[dict] = None


def set_bundle_dir(path: Union[str, Path]) -> None:
    """Point relative data-file lookups at the extracted bundle."""
    global _bundle_dir, root_path
    _bundle_dir = Path(path).resolve()
    root_path = _bundle_dir


def set_platform_manga_id_map(manga_map: Optional[dict]) -> None:
    """Install the control plane's tracked-manga map as the authoritative one.

    The database, not a file committed to the bundle, is the source of truth
    for which series an extension tracks. Titles auto-tracked since the bundle
    was published therefore reach the extension without republishing it. An
    empty or missing map leaves the bundle's own file in charge, so an
    extension is never starved by a control plane that has nothing to say.
    """
    global _platform_manga_id_map
    _platform_manga_id_map = manga_map or None


def resolve_bundle_path(path: Union[str, Path]) -> Path:
    candidate = Path(path)
    if candidate.is_absolute() or _bundle_dir is None:
        return candidate
    return _bundle_dir.joinpath(candidate)


def atomic_write_text(path: Path, content: str, encoding: str = "utf-8") -> None:
    """Write content to path via temp-file + os.replace so a crash mid-write
    can never leave a half-written file at the destination."""
    path = resolve_bundle_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding=encoding) as tmp:
            tmp.write(content)
            tmp.flush()
            os.fsync(tmp.fileno())

        try:
            os.replace(tmp_name, path)
            return
        except OSError as e:
            if e.errno not in (errno.EBUSY, errno.EXDEV, errno.EPERM):
                raise
            with open(path, "w", encoding=encoding) as fp:
                fp.write(content)
                fp.flush()
                os.fsync(fp.fileno())
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
        except OSError:
            logger.debug(f"Couldn't clean up temp file {tmp_name}", exc_info=True)


def open_manga_id_map(manga_map_path: Path) -> dict:
    """Open external id to mangadex id map.

    Every call is served the control plane's map when it sent one, whatever
    filename the extension asked for: an extension has exactly one tracked
    map, and the database is authoritative for it. The requested path is
    logged so the substitution is visible in the job's logs.
    """
    if _platform_manga_id_map is not None:
        logger.info(
            f"Using the platform-provided manga id map "
            f"({len(_platform_manga_id_map)} titles) in place of {manga_map_path}."
        )
        return _platform_manga_id_map

    manga_map_path = resolve_bundle_path(manga_map_path)
    try:
        with open(manga_map_path, "r") as manga_map_fp:
            manga_map = json.load(manga_map_fp)
    except json.JSONDecodeError as e:
        logger.critical("Manga map file is corrupted.")
        raise json.JSONDecodeError(
            msg="Manga map file is corrupted.", doc=e.doc, pos=e.pos
        )
    except FileNotFoundError:
        logger.critical("Manga map file is missing.")
        raise FileNotFoundError("Couldn't file manga map file.")
    return manga_map


def open_title_regex(override_options_path: Path) -> dict:
    """Open the custom regexes."""
    override_options_path = resolve_bundle_path(override_options_path)
    try:
        with open(override_options_path, "r") as title_regex_fp:
            override_options = json.load(title_regex_fp)
    except json.JSONDecodeError:
        logger.error(f"Title regex file is corrupted: {override_options_path}")
        return {}
    except FileNotFoundError:
        logger.info(f"No title regex file at {override_options_path}, using empty.")
        return {}
    return override_options


def open_manga_data(manga_data_path: Path) -> Dict[str, dict]:
    """Open MangaDex titles data."""
    manga_data_path = resolve_bundle_path(manga_data_path)
    manga_data: Dict[str, dict] = {}
    try:
        with open(manga_data_path, "r") as manga_data_fp:
            manga_data = json.load(manga_data_fp)
    except json.JSONDecodeError:
        logger.error(f"Manga data file is corrupted: {manga_data_path}")
    except FileNotFoundError:
        logger.info(f"No manga data file at {manga_data_path}, starting empty.")
    return manga_data


def get_current_datetime():
    """Get current datetime as timezone-aware."""
    return datetime.datetime.now(tz=datetime.timezone.utc)


chapter_number_regex = re.compile(r"^(0|[1-9]\d*)((\.\d+){1,2})?[a-z]?$", re.I)
EXPIRE_TIME = datetime.datetime(year=1990, month=1, day=1, tzinfo=datetime.timezone.utc)
