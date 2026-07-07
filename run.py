import argparse
import json
import logging
import os
import queue
import re
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import time as dtTime, timezone
from importlib import reload
from pathlib import Path
from typing import Optional

from scheduler import Scheduler

from publoader.github_webhook import GithubWebhookListener
from publoader.ipc import IPCServer, ipc_call, is_instance_running
from publoader.state import get_state_store
from publoader.updater import PubloaderUpdater
from publoader.utils.config import (
    config,
    daily_run_time_checks_hour,
    daily_run_time_checks_minute,
    daily_run_time_daily_hour,
    daily_run_time_daily_minute,
    github_webhook_enabled,
    github_webhook_host,
    github_webhook_path,
    github_webhook_port,
    github_webhook_secret,
)
from publoader.utils.utils import (
    get_current_datetime,
    root_path,
)
from publoader.models.database import get_database_connection
from publoader.workers import worker

logger = logging.getLogger("publoader")

# Job kinds the IPC handlers enqueue for the main loop to drain.
JOB_RUN = "run"
JOB_RESTART = "restart"
JOB_PULL = "pull"

# Liveness heartbeat. A daemon thread rewrites this file every few seconds; the
# container healthcheck (docker-compose) treats a stale/missing file as "process
# wedged" and lets autoheal restart the container. Kept independent of the
# scheduler loop on purpose: it keeps ticking through long extension runs (so a
# busy-but-healthy bot is never falsely restarted) and stops only when the
# process is truly dead or the interpreter is hard-wedged — exactly when a
# restart is the right move. /tmp survives os.execv (the daily restarter) and is
# recreated within the healthcheck's start_period after a container restart.
HEARTBEAT_PATH = Path("/tmp/publoader_heartbeat")
HEARTBEAT_INTERVAL_SECONDS = 5

# Holds (kind, payload) tuples; populated by IPC threads, drained on main thread.
_ipc_jobs: "queue.Queue" = queue.Queue()
_run_lock = threading.Lock()

# Extensions currently queued-but-not-yet-completed or actively executing.
# Used to reject duplicate /run /force / /clean for the same extension while
# one is in flight, so a re-trigger can't kick off the same extension twice.
_inflight_extensions: set = set()
_inflight_lock = threading.Lock()

# Pause gate. While `time.time() < _pause_until` the scheduler skips its due
# jobs and manual /run requests are rejected. Mirrored to the state DB setting
# `pause_until` so a restart mid-pause still honours it. 0 = not paused;
# `float("inf")` = paused indefinitely (until an explicit /resume).
_PAUSE_SETTING_KEY = "pause_until"
_pause_lock = threading.Lock()
_pause_until = 0.0
# Sentinel deadline for an indefinite pause. Persists to the DB as the string
# "inf" and round-trips cleanly through float().
_INDEFINITE_PAUSE = float("inf")


def _set_pause_until(epoch: float) -> None:
    global _pause_until
    with _pause_lock:
        _pause_until = epoch
    try:
        store = get_state_store()
        if epoch > 0:
            store.set_setting(_PAUSE_SETTING_KEY, str(epoch))
        else:
            store.clear_setting(_PAUSE_SETTING_KEY)
    except sqlite3.Error:
        logger.warning("Couldn't persist pause state", exc_info=True)


def _load_pause_until() -> None:
    """Restore a pause deadline from the state DB on startup (best-effort)."""
    global _pause_until
    try:
        raw = get_state_store().get_setting(_PAUSE_SETTING_KEY)
    except sqlite3.Error:
        return
    if not raw:
        return
    try:
        with _pause_lock:
            _pause_until = float(raw)
    except (TypeError, ValueError):
        pass


def _is_paused() -> bool:
    with _pause_lock:
        return time.time() < _pause_until


def _pause_remaining() -> float:
    with _pause_lock:
        return max(0.0, _pause_until - time.time())


def _is_paused_indefinitely() -> bool:
    with _pause_lock:
        return _pause_until == _INDEFINITE_PAUSE


def _pause_remaining_report() -> Optional[int]:
    """Whole seconds until auto-resume for status payloads. None when paused
    indefinitely (no deadline), 0 when not paused."""
    remaining = _pause_remaining()
    if remaining == _INDEFINITE_PAUSE:
        return None
    return int(remaining)


def _claim_extensions(names):
    """Atomically claim a set of extension names. Returns (accepted, skipped)."""
    accepted, skipped = [], []
    with _inflight_lock:
        for name in names:
            if name in _inflight_extensions:
                skipped.append(name)
            else:
                _inflight_extensions.add(name)
                accepted.append(name)
    return accepted, skipped


def _release_extensions(names):
    if not names:
        return
    with _inflight_lock:
        _inflight_extensions.difference_update(names)


def _record_run_started(extension_names, general_run, clean_db, triggered_by):
    """Best-effort run_history insert. Never let bookkeeping break a run."""
    kind = "clean" if clean_db else ("force" if general_run else "run")
    ext = ", ".join(extension_names) if extension_names else "all"
    try:
        return get_state_store().record_run_started(ext, kind, triggered_by)
    except sqlite3.Error:
        logger.warning("Couldn't record run start", exc_info=True)
        return None


def _record_run_completed(run_id, success):
    if run_id is None:
        return
    try:
        get_state_store().record_run_completed(run_id, success)
    except sqlite3.Error:
        logger.warning("Couldn't record run completion", exc_info=True)


def main(
    database_connection,
    extension_names: list[str] = None,
    general_run=False,
    clean_db=False,
    triggered_by: str = None,
):
    """Call the main function of the publoader bot."""
    from publoader import publoader

    reload(publoader)
    run_id = _record_run_started(
        extension_names, general_run, clean_db, triggered_by
    )
    success = False
    try:
        with _run_lock:
            publoader.open_extensions(
                database_connection,
                names=extension_names,
                general_run=general_run,
                clean_db=clean_db,
            )
        success = True
    finally:
        _record_run_completed(run_id, success)
        _release_extensions(extension_names or [])


def _open_json_timings() -> dict:
    """Read every `schedule*.json` under publoader/extensions/."""
    timings: dict = {}
    for schedule_file in root_path.joinpath("publoader", "extensions").glob(
        "schedule*.json"
    ):
        try:
            timings.update(json.loads(schedule_file.read_bytes()))
        except json.JSONDecodeError:
            pass
    return timings


def open_timings() -> dict:
    """Effective timings: JSON defaults overridden by DB entries (when present).

    Falls back to JSON-only when the state DB file doesn't exist on disk yet —
    matching the user-stated rule "if a db exists, otherwise just run the
    default from the timings json".
    """
    timings = _open_json_timings()
    try:
        store = get_state_store()
    except sqlite3.Error as e:
        logger.warning(f"State DB unavailable, using schedule.json only: {e}")
        return timings

    if not store.exists_on_disk():
        return timings

    overrides = store.get_schedule_overrides()
    if not overrides:
        return timings

    timings.update(overrides)
    return timings


def schedule_extensions(database_connection):
    """Compute timing buckets and register them with the global `schedule`.
    Returns the bucket list."""
    same: list = []
    timings = open_timings()
    now = get_current_datetime()

    for timing in timings:
        extension_timings = timings[timing]
        day = extension_timings.get("day")
        hour = extension_timings.get("hour", daily_run_time_daily_hour)
        minute = extension_timings.get("minute", daily_run_time_daily_minute)

        # `day` per the extensions-repo contract is day-of-week (0-6, Monday=0).
        if day is not None and day != now.weekday():
            continue

        # Join extensions to run together if they are scheduled to run within
        # seven minutes of each other.
        for bucket in same:
            if (
                hour == bucket["hour"]
                and bucket["minute"] - 7 <= minute <= bucket["minute"] + 7
                and timing not in bucket["extensions"]
            ):
                bucket["extensions"].append(timing)
                break
        else:
            same.append({"hour": hour, "minute": minute, "extensions": [timing]})

    for fixed_timing in same:
        schedule.daily(
            dtTime(
                hour=fixed_timing["hour"],
                minute=fixed_timing["minute"],
                tzinfo=timezone.utc,
            ),
            main,
            weight=1,
            alias=", ".join(fixed_timing["extensions"]),
            tags=set(fixed_timing["extensions"]),
            kwargs={
                "database_connection": database_connection,
                "extension_names": list(fixed_timing["extensions"]),
            },
        )
    return same


def _reschedule_all(database_connection) -> None:
    """Drop every per-extension job and rebuild from the current effective
    timings. Called after `/schedule set` or `/schedule remove` so the live
    scheduler reflects new DB state without a full process restart."""
    sched = globals().get("schedule")
    if sched is None:
        return

    preserved = {"restarter", "daily_checker"}
    for job in list(getattr(sched, "jobs", [])):
        tags = getattr(job, "tags", set()) or set()
        if not (tags & preserved):
            try:
                sched.delete_job(job)
            except Exception:
                logger.exception("Failed to delete a schedule job during reschedule")

    schedule_extensions(database_connection)


def _requirements_satisfied(req_file) -> bool:
    """Return True if every requirement in `req_file` is already installed.
    Returns False on any unmet requirement, parse failure, VCS/URL spec, or
    nested -r include — so we err on the side of running pip."""
    try:
        from importlib.metadata import PackageNotFoundError, distribution
        from packaging.requirements import InvalidRequirement, Requirement
    except ImportError:
        return False

    try:
        lines = req_file.read_text(encoding="utf-8").splitlines()
    except OSError:
        return False

    for raw in lines:
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        # Requirement options like -r/-e/-c/--index-url: bail out and let pip handle.
        if line.startswith("-"):
            return False
        # VCS/URL specs (git+https, http://, file://) aren't parseable as Requirements.
        if "://" in line or line.startswith(("git+", "hg+", "svn+", "bzr+")):
            return False

        try:
            req = Requirement(line)
        except InvalidRequirement:
            return False

        if req.marker is not None and not req.marker.evaluate():
            continue

        try:
            dist = distribution(req.name)
        except PackageNotFoundError:
            return False

        if req.specifier and dist.version not in req.specifier:
            return False

    return True


def install_requirements():
    """Install requirements for the extensions, skipping files that are already satisfied."""
    for file in root_path.rglob("requirements.txt"):
        resolved = file.resolve()
        if _requirements_satisfied(resolved):
            print(f"Requirements already satisfied for {resolved}, skipping.")
            continue

        print(f"Installing requirements from {resolved}")
        try:
            result = subprocess.run(
                [sys.executable, "-m", "pip", "install", "-r", str(resolved)],
                check=False,
            )
        except (FileNotFoundError, OSError) as e:
            logger.error(f"Failed to invoke pip for {resolved}: {e}")
            continue
        print(
            "Requirements installation completed with error code",
            f"{result.returncode} for file {resolved}",
        )


def restart():
    """Restart the script."""
    worker.kill()
    updater = PubloaderUpdater()
    updater.update()
    install_requirements()

    print(f"Restarting with args {sys.executable=} {sys.argv=}")
    os.execv(sys.executable, [sys.executable, sys.argv[0]])


def _worker_queue_lengths(database_connection) -> list:
    """Per-worker pending queue depth, one entry per watcher subprocess.

    Each worker drains a dedicated MongoDB collection and deletes rows once
    they're processed, so the live document count is the authoritative pending
    work for that worker (more reliable than the in-process queue, which lives
    inside each subprocess and isn't reachable from here)."""
    workers = []
    for w in worker.WATCHERS:
        entry = {"name": w["name"], "table": w["table"]}
        try:
            entry["queued"] = int(database_connection[w["table"]].count_documents({}))
        except Exception as e:  # pragma: no cover - defensive
            entry["queued"] = None
            entry["error"] = str(e)
        workers.append(entry)
    return workers


_EXT_NAME_RE = re.compile(r"^[a-z0-9_]+$")


_PULL_REPOS = ("base", "extensions", "extensions-private")

# Log scope -> folder under <root>/logs. workers/extensions hold per-name
# subfolders; the rest hold a single dated file.
_LOG_SCOPES = {
    "bot": ("logs", "bot"),
    "workers": ("logs", "workers"),
    "webhook": ("logs", "webhook"),
    "debug": ("logs", "debug"),
    "extensions": ("logs", "extensions"),
}

# config.ini keys that must never be echoed back over Discord in full.
_SECRET_CONFIG_KEYS = {
    "mangadex_password",
    "client_secret",
    "mongodb_uri",
    "discord_bot_token",
    "github_access_token",
}


def _redact_secret(key: str, value: str) -> str:
    if value and key.lower() in _SECRET_CONFIG_KEYS:
        tail = value[-4:] if len(value) > 4 else ""
        return f"***set*** (…{tail})" if tail else "***set***"
    return value


def _worker_tables() -> dict:
    """Map worker name -> MongoDB collection it drains."""
    return {w["name"]: w["table"] for w in worker.WATCHERS}


def _tail_lines(path: Path, lines: int) -> str:
    """Return the last `lines` lines of a text file. Reads the whole file —
    log files are rotated daily and capped by clear_old_logs, so they stay
    small enough that a full read is simpler than seeking."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            data = fh.read().splitlines()
    except OSError as e:
        return f"<could not read {path.name}: {e}>"
    if not data:
        return "<empty>"
    return "\n".join(data[-lines:])


def _resolve_log_file(scope: str, name) -> Path:
    """Folder for `scope` (+ optional per-name subfolder), then the newest
    *.log inside it. Raises ValueError on bad scope/name (path-traversal safe)."""
    parts = _LOG_SCOPES.get(scope)
    if parts is None:
        raise ValueError(
            f"unknown log scope {scope!r}; choose one of {sorted(_LOG_SCOPES)}"
        )
    folder = root_path.joinpath(*parts)
    if scope in ("workers", "extensions") and name:
        name = str(name).strip()
        if not _EXT_NAME_RE.match(name) and name not in _worker_tables():
            raise ValueError(f"invalid {scope} name: {name!r}")
        folder = folder.joinpath(name)
    candidates = sorted(
        folder.glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True
    )
    if not candidates:
        raise ValueError(f"no log files under {folder}")
    return candidates[0]


def _enqueue_push_update(slot: str, payload: dict) -> None:
    """Webhook callback: a push landed on a tracked repo, queue the matching
    update for the main loop to run.

    A push to the base repo changes core code, so it takes the full
    download+re-exec path (`restart()`) — the same path as the daily fallback.
    A push to an extension repo only needs that repo pulled and the extension
    modules re-imported, so it takes the lighter pull+reload path and avoids
    restarting the whole process (and interrupting any in-flight run).

    Called from the webhook server thread, so it only touches the thread-safe
    job queue — the heavy work happens on the main thread."""
    after = ((payload or {}).get("after") or "")[:7]
    sha = after or "unknown sha"
    if slot == "base":
        logger.info(f"Push received for base repo ({sha}); queuing update + restart.")
        _ipc_jobs.put((JOB_RESTART, {}))
    else:
        logger.info(f"Push received for {slot!r} ({sha}); queuing pull + reload.")
        _ipc_jobs.put((JOB_PULL, {"repos": [slot]}))


def _build_repo_slots() -> dict:
    """GitHub repo name -> internal slot, matching the repos the updater pulls."""
    slots = {
        config["Repo"]["base_repo_path"]: "base",
        config["Repo"]["extensions_repo_path"]: "extensions",
    }
    private = config["Repo"].get("extensions_private_repo_path")
    if private:
        slots[private] = "extensions-private"
    return slots


def _start_webhook_listener():
    """Start the GitHub push-webhook listener when enabled and configured.
    Returns the listener (so the caller can stop it) or None."""
    if not github_webhook_enabled:
        return None
    if not github_webhook_secret:
        logger.warning(
            "GitHub webhook listener enabled but [GithubWebhook]secret is unset; "
            "refusing to start an unauthenticated update trigger."
        )
        return None
    try:
        listener = GithubWebhookListener(
            host=github_webhook_host,
            port=github_webhook_port,
            path=github_webhook_path,
            secret=github_webhook_secret,
            owner=config["Repo"]["repo_owner"],
            repo_slots=_build_repo_slots(),
            on_push=_enqueue_push_update,
        )
        listener.start()
        return listener
    except OSError:
        logger.exception("Failed to start GitHub webhook listener")
        return None


def _write_heartbeat() -> None:
    """Atomically stamp the heartbeat file with the current time.

    Write-then-rename so a concurrent healthcheck reader never catches the file
    mid-truncate (an empty read would otherwise look like a stale heartbeat and
    spuriously mark the container unhealthy). os.replace is atomic within a
    filesystem, which /tmp always satisfies."""
    tmp = HEARTBEAT_PATH.with_name(HEARTBEAT_PATH.name + ".tmp")
    try:
        tmp.write_text(str(time.time()))
        os.replace(tmp, HEARTBEAT_PATH)
    except OSError:
        logger.debug("Couldn't write heartbeat file", exc_info=True)


def _heartbeat_loop() -> None:
    while True:
        _write_heartbeat()
        time.sleep(HEARTBEAT_INTERVAL_SECONDS)


def _start_heartbeat() -> threading.Thread:
    """Start the liveness-heartbeat daemon thread (see HEARTBEAT_PATH)."""
    # Write an initial beat synchronously so the healthcheck has something to
    # read immediately, rather than waiting a full interval after startup.
    _write_heartbeat()
    thread = threading.Thread(target=_heartbeat_loop, name="heartbeat", daemon=True)
    thread.start()
    return thread


def _setup_ipc_server(database_connection) -> IPCServer:
    """Register handlers that enqueue jobs for the main loop to execute."""
    server = IPCServer()

    def cmd_run(req):
        if _is_paused():
            return {
                "queued": False,
                "paused": True,
                "error": "bot is paused",
                "resumes_in_seconds": _pause_remaining_report(),
            }

        extensions = req.get("extensions")
        if extensions is None and req.get("extension"):
            extensions = [req["extension"]]

        skipped: list = []
        if extensions:
            # Drop names that are already in-flight so the same extension can't
            # be queued twice (otherwise main loop would run it back-to-back).
            extensions, skipped = _claim_extensions(extensions)
            if not extensions:
                return {
                    "queued": False,
                    "skipped": skipped,
                    "reason": "extension(s) already running or queued",
                }

        _ipc_jobs.put(
            (
                JOB_RUN,
                {
                    "extension_names": extensions,
                    "general_run": bool(req.get("force", False)),
                    "clean_db": bool(req.get("clean", False)),
                    "triggered_by": req.get("triggered_by") or "discord",
                },
            )
        )
        result = {"queued": True, "extensions": extensions}
        if skipped:
            result["skipped"] = skipped
        return result

    def cmd_reload(_req):
        # The next main() call already reloads the publoader package; queue a no-op run
        # with no extensions which will trigger reload via importlib.reload.
        _ipc_jobs.put(
            (
                JOB_RUN,
                {
                    "extension_names": None,
                    "general_run": False,
                    "clean_db": False,
                    "triggered_by": "reload",
                },
            )
        )
        return {"reloaded": True}

    def cmd_restart(_req):
        _ipc_jobs.put((JOB_RESTART, {}))
        return {"restarting": True}

    def cmd_status(_req):
        sched = globals().get("schedule")
        return {
            "pid": os.getpid(),
            "jobs": [str(j) for j in getattr(sched, "jobs", [])] if sched else [],
            "workers": _worker_queue_lengths(database_connection),
            "paused": _is_paused(),
            "pause_remaining_seconds": _pause_remaining_report(),
            "pause_indefinite": _is_paused_indefinitely(),
        }

    def cmd_pull(req):
        """Pull the latest changes for one or more repos via the GitHub tarball
        API. Accepted names are 'base', 'extensions', 'extensions-private', or
        the alias 'all'. Delegates to PubloaderUpdater so the existing PAT in
        [Repo]github_access_token authenticates private-repo downloads."""
        names = req.get("repos") or req.get("repo")
        if isinstance(names, str):
            names = [names]
        if not names:
            return {"ok": False, "error": "no repos requested"}
        if "all" in names:
            names = list(_PULL_REPOS)

        try:
            updater = PubloaderUpdater()
        except Exception as e:
            logger.exception("updater init failed")
            return {"ok": False, "error": f"updater init failed: {e}"}

        per_repo: dict = {}
        any_changed = False
        any_ok = True
        for name in names:
            if name not in _PULL_REPOS:
                per_repo[name] = {"ok": False, "error": f"unknown repo {name!r}"}
                any_ok = False
                continue
            try:
                status = updater.update_one(name)
            except Exception as e:  # pragma: no cover - defensive
                logger.exception(f"pull for {name} crashed")
                per_repo[name] = {"ok": False, "error": str(e)}
                any_ok = False
                continue
            per_repo[name] = status
            if not status.get("ok"):
                any_ok = False
            if status.get("changed"):
                any_changed = True

        return {"ok": any_ok, "changed": any_changed, "repos": per_repo}

    def cmd_list_schedule(_req):
        effective = open_timings()
        try:
            db_overrides = get_state_store().get_schedule_overrides()
        except sqlite3.Error as e:
            db_overrides = {}
            logger.warning(f"State DB read failed: {e}")
        return {"ok": True, "effective": effective, "db_overrides": db_overrides}

    def cmd_set_schedule(req):
        ext = (req.get("extension") or "").strip()
        hour = req.get("hour")
        minute = req.get("minute")
        day = req.get("day")

        if not _EXT_NAME_RE.match(ext):
            return {"ok": False, "error": f"invalid extension name: {ext!r}"}
        if not isinstance(hour, int) or not 0 <= hour <= 23:
            return {"ok": False, "error": f"hour must be int 0-23 (got {hour!r})"}
        if not isinstance(minute, int) or not 0 <= minute <= 59:
            return {"ok": False, "error": f"minute must be int 0-59 (got {minute!r})"}
        if day is not None and (not isinstance(day, int) or not 0 <= day <= 6):
            return {
                "ok": False,
                "error": f"day must be int 0-6 (Mon=0) or null (got {day!r})",
            }

        try:
            get_state_store().upsert_schedule(ext, hour, minute, day)
        except sqlite3.Error as e:
            return {"ok": False, "error": f"state DB write failed: {e}"}

        try:
            _reschedule_all(database_connection)
        except Exception as e:  # pragma: no cover - defensive
            logger.exception("reschedule failed")
            return {
                "ok": True,
                "stored": True,
                "rescheduled": False,
                "error": f"stored but reschedule failed: {e}",
            }
        return {"ok": True, "stored": True, "rescheduled": True}

    def cmd_remove_schedule(req):
        ext = (req.get("extension") or "").strip()
        if not _EXT_NAME_RE.match(ext):
            return {"ok": False, "error": f"invalid extension name: {ext!r}"}
        try:
            removed = get_state_store().remove_schedule(ext)
        except sqlite3.Error as e:
            return {"ok": False, "error": f"state DB write failed: {e}"}

        if removed == 0:
            return {"ok": True, "removed": False, "reason": "no DB override existed"}

        try:
            _reschedule_all(database_connection)
        except Exception as e:  # pragma: no cover - defensive
            logger.exception("reschedule failed")
            return {
                "ok": True,
                "removed": True,
                "rescheduled": False,
                "error": str(e),
            }
        return {"ok": True, "removed": True, "rescheduled": True}

    def _extensions_on_disk() -> list:
        """Names of every extension dir in the runtime extensions volume.
        Mirrors the iteration done by load_extensions.load_extensions()."""
        try:
            folder = root_path.joinpath("publoader", "extensions", "src")
            return sorted(
                p.name
                for p in folder.iterdir()
                if p.is_dir() and p.name != "__pycache__" and not p.name.startswith(".")
            )
        except (FileNotFoundError, NotADirectoryError, PermissionError):
            return []

    def cmd_list_extensions(_req):
        try:
            disabled = set(get_state_store().list_disabled_extensions())
        except sqlite3.Error as e:
            return {"ok": False, "error": f"state DB read failed: {e}"}
        names = _extensions_on_disk()
        return {
            "ok": True,
            "extensions": [{"name": n, "disabled": n in disabled} for n in names],
            "disabled": sorted(disabled),
        }

    def cmd_disable_extension(req):
        ext = (req.get("extension") or "").strip()
        if not _EXT_NAME_RE.match(ext):
            return {"ok": False, "error": f"invalid extension name: {ext!r}"}
        try:
            added = get_state_store().disable_extension(ext)
        except (sqlite3.Error, ValueError) as e:
            return {"ok": False, "error": f"state DB write failed: {e}"}
        return {"ok": True, "extension": ext, "disabled": True, "changed": added}

    def cmd_enable_extension(req):
        ext = (req.get("extension") or "").strip()
        if not _EXT_NAME_RE.match(ext):
            return {"ok": False, "error": f"invalid extension name: {ext!r}"}
        try:
            removed = get_state_store().enable_extension(ext)
        except (sqlite3.Error, ValueError) as e:
            return {"ok": False, "error": f"state DB write failed: {e}"}
        return {"ok": True, "extension": ext, "disabled": False, "changed": removed}

    def cmd_get_removal_mode(_req):
        from publoader.state.store import (
            DEFAULT_REMOVAL_MODE,
            VALID_REMOVAL_MODES,
        )

        try:
            mode = get_state_store().get_removal_mode()
            row_set = get_state_store().get_setting("chapter_removal_mode")
        except sqlite3.Error as e:
            return {"ok": False, "error": f"state DB read failed: {e}"}
        return {
            "ok": True,
            "mode": mode,
            "explicit": row_set is not None,
            "default": DEFAULT_REMOVAL_MODE,
            "valid_modes": list(VALID_REMOVAL_MODES),
        }

    def cmd_set_removal_mode(req):
        from publoader.state.store import VALID_REMOVAL_MODES

        mode = (req.get("mode") or "").strip().lower()
        if mode not in VALID_REMOVAL_MODES:
            return {
                "ok": False,
                "error": (
                    f"mode must be one of {list(VALID_REMOVAL_MODES)} (got {mode!r})"
                ),
            }
        try:
            get_state_store().set_removal_mode(mode)
        except sqlite3.Error as e:
            return {"ok": False, "error": f"state DB write failed: {e}"}
        return {"ok": True, "mode": mode}

    def cmd_run_history(req):
        ext = (req.get("extension") or "").strip() or None
        if ext is not None and not _EXT_NAME_RE.match(ext):
            return {"ok": False, "error": f"invalid extension name: {ext!r}"}
        try:
            limit = int(req.get("limit") or 15)
        except (TypeError, ValueError):
            limit = 15
        try:
            runs = get_state_store().recent_runs(limit=limit, extension=ext)
        except sqlite3.Error as e:
            return {"ok": False, "error": f"state DB read failed: {e}"}
        return {"ok": True, "runs": runs}

    def cmd_logs(req):
        """Tail a log file. With no scope, list the scopes available. For
        `workers`/`extensions` a `name` selects the per-name subfolder."""
        scope = (req.get("scope") or "").strip().lower()
        if not scope:
            return {"ok": True, "scopes": sorted(_LOG_SCOPES), "workers": sorted(_worker_tables())}
        try:
            lines = int(req.get("lines") or 40)
        except (TypeError, ValueError):
            lines = 40
        lines = max(1, min(lines, 200))
        try:
            path = _resolve_log_file(scope, req.get("name"))
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        return {
            "ok": True,
            "scope": scope,
            "file": path.name,
            "lines": lines,
            "text": _tail_lines(path, lines),
        }

    def cmd_queue_peek(req):
        """Sample documents from a worker's MongoDB collection. `worker` accepts
        a worker name (uploader/…) or the raw collection name."""
        tables = _worker_tables()
        name = (req.get("worker") or req.get("table") or "").strip()
        table = tables.get(name, name)
        if table not in tables.values():
            return {
                "ok": False,
                "error": f"unknown worker/table {name!r}; choose from {sorted(tables)}",
            }
        try:
            limit = int(req.get("limit") or 5)
        except (TypeError, ValueError):
            limit = 5
        limit = max(1, min(limit, 20))
        try:
            collection = database_connection[table]
            total = int(collection.count_documents({}))
            sample = []
            for doc in collection.find({}, limit=limit):
                sample.append(
                    {
                        "_id": str(doc.get("_id")),
                        "md_chapter_id": doc.get("md_chapter_id"),
                        "manga_id": doc.get("manga_id") or doc.get("md_manga_id"),
                        "chapter_number": doc.get("chapter_number"),
                        "extension_name": doc.get("extension_name"),
                    }
                )
        except Exception as e:  # pragma: no cover - defensive
            return {"ok": False, "error": f"mongo read failed: {e}"}
        return {"ok": True, "worker": name, "table": table, "queued": total, "sample": sample}

    def cmd_queue_clear(req):
        """Empty a worker's MongoDB collection. Destructive — admin-gated in the bot."""
        tables = _worker_tables()
        name = (req.get("worker") or req.get("table") or "").strip()
        table = tables.get(name, name)
        if table not in tables.values():
            return {
                "ok": False,
                "error": f"unknown worker/table {name!r}; choose from {sorted(tables)}",
            }
        try:
            result = database_connection[table].delete_many({})
        except Exception as e:  # pragma: no cover - defensive
            return {"ok": False, "error": f"mongo delete failed: {e}"}
        return {"ok": True, "worker": name, "table": table, "deleted": result.deleted_count}

    def cmd_restart_workers(_req):
        """Kill and respawn the watcher subprocesses without restarting the
        whole scheduler. Useful when a worker wedges on a bad request."""
        try:
            worker.kill()
            worker.main(database_connection)
        except Exception as e:  # pragma: no cover - defensive
            logger.exception("worker restart failed")
            return {"ok": False, "error": str(e)}
        return {"ok": True, "restarted": sorted(_worker_tables())}

    def cmd_stats(_req):
        """Document counts for the worker queues plus the core collections."""
        out: dict = {"queues": {}, "collections": {}}
        for name, table in _worker_tables().items():
            try:
                out["queues"][name] = int(database_connection[table].count_documents({}))
            except Exception as e:  # pragma: no cover - defensive
                out["queues"][name] = f"error: {e}"
        for coll in ("uploaded", "chapters", "manga", "to_upload"):
            try:
                if coll in database_connection.list_collection_names():
                    out["collections"][coll] = int(
                        database_connection[coll].count_documents({})
                    )
            except Exception as e:  # pragma: no cover - defensive
                out["collections"][coll] = f"error: {e}"
        return {"ok": True, **out}

    def cmd_config_show(req):
        section = (req.get("section") or "").strip()
        out: dict = {}
        sections = [section] if section else list(config.sections())
        for sec in sections:
            if sec not in config:
                return {"ok": False, "error": f"unknown section {sec!r}"}
            out[sec] = {
                key: _redact_secret(key, value)
                for key, value in config[sec].items()
            }
        return {"ok": True, "config": out}

    def cmd_config_set(req):
        section = (req.get("section") or "").strip()
        key = (req.get("key") or "").strip()
        value = req.get("value")
        if section not in config:
            return {"ok": False, "error": f"unknown section {section!r}"}
        if not key:
            return {"ok": False, "error": "key is required"}
        if value is None:
            return {"ok": False, "error": "value is required"}
        config[section][key] = str(value)
        try:
            from publoader.utils.config import config_file_path

            with open(config_file_path, "w", encoding="utf-8") as fh:
                config.write(fh)
        except OSError as e:
            return {"ok": False, "error": f"config write failed: {e}"}
        return {
            "ok": True,
            "section": section,
            "key": key,
            "value": _redact_secret(key, str(value)),
            "note": "written to config.ini — most values need a /restart to apply.",
        }

    def cmd_mdauth_status(_req):
        """Report whether the saved MangaDex token exists and when it expires,
        decoding the JWT `exp` claim without verifying the signature."""
        import base64
        from datetime import datetime, timezone as _tz

        token_file = root_path.joinpath(config["Paths"]["mdauth_path"])
        if not token_file.exists():
            return {"ok": True, "exists": False, "note": "no mdauth file; logs in with account details."}
        try:
            data = json.loads(token_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            return {"ok": False, "error": f"could not read mdauth file: {e}"}

        out = {"ok": True, "exists": True, "has_access": bool(data.get("access")),
               "has_refresh": bool(data.get("refresh"))}
        access = data.get("access") or ""
        try:
            payload_b64 = access.split(".")[1]
            payload_b64 += "=" * (-len(payload_b64) % 4)
            claims = json.loads(base64.urlsafe_b64decode(payload_b64))
            exp = claims.get("exp")
            if exp:
                expires = datetime.fromtimestamp(exp, tz=_tz.utc)
                now = datetime.now(tz=_tz.utc)
                out["access_expires_at"] = expires.isoformat()
                out["access_expired"] = expires <= now
                out["expires_in_seconds"] = int((expires - now).total_seconds())
        except (ValueError, IndexError, KeyError, json.JSONDecodeError):
            out["note"] = "access token present but not a decodable JWT."
        return out

    def cmd_force_login(req):
        """Force a fresh MangaDex login (password grant) and persist the new
        token to mdauth.json. With force=False, validate/refresh the existing
        token instead."""
        from publoader.http.client import HTTPClient

        force = bool(req.get("force", True))
        try:
            client = HTTPClient()
            if force:
                ok = client.oauth.login()
                if ok:
                    client._update_headers(client.access_token)
                    client._save_tokens(client.access_token, client.refresh_token)
            else:
                client.login()
                ok = True
        except Exception as e:
            logger.exception("force login failed")
            return {"ok": False, "error": str(e)}
        if not ok:
            return {"ok": False, "error": "login rejected by MangaDex (check credentials)"}
        return {
            "ok": True,
            "logged_in": True,
            "forced": force,
            "note": "token written to mdauth.json; /workers restart to propagate to workers.",
        }

    def cmd_logout(_req):
        """Invalidate the current MangaDex session: delete mdauth.json and clear
        the in-memory tokens so the next request re-authenticates from scratch."""
        token_file = root_path.joinpath(config["Paths"]["mdauth_path"])
        existed = token_file.exists()
        try:
            token_file.unlink()
        except FileNotFoundError:
            existed = False
        except OSError as e:
            return {"ok": False, "error": f"could not delete mdauth file: {e}"}

        # Best-effort: clear the running singleton's cached tokens (name-mangled
        # on OAuth2) so the live process stops using the old session too.
        try:
            from publoader.http.client import HTTPClient

            client = HTTPClient()
            client.oauth._OAuth2__access_token = None
            client.oauth._OAuth2__refresh_token = None
            client._first_login = True
            client._successful_login = False
        except Exception:
            logger.debug("Couldn't clear in-memory tokens on logout", exc_info=True)

        return {
            "ok": True,
            "logged_out": True,
            "file_removed": existed,
            "note": "workers keep their own session until /workers restart.",
        }

    def cmd_pause(req):
        minutes = req.get("minutes")
        # Omitting minutes (or passing 0/null) pauses indefinitely until /resume.
        if minutes is None or minutes == 0:
            _set_pause_until(_INDEFINITE_PAUSE)
            return {
                "ok": True,
                "paused": True,
                "minutes": None,
                "indefinite": True,
                "resumes_in_seconds": None,
                "note": "paused indefinitely; scheduled runs, manual runs and worker "
                "queue processing stay suspended until /resume.",
            }
        try:
            minutes = int(minutes)
        except (TypeError, ValueError):
            return {"ok": False, "error": f"minutes must be an integer (got {minutes!r})"}
        if not 1 <= minutes <= 1440:
            return {"ok": False, "error": "minutes must be between 1 and 1440 (24h)"}
        deadline = time.time() + minutes * 60
        _set_pause_until(deadline)
        return {
            "ok": True,
            "paused": True,
            "minutes": minutes,
            "indefinite": False,
            "resumes_in_seconds": _pause_remaining_report(),
            "note": "scheduled runs, manual runs and worker queue processing are all suspended.",
        }

    def cmd_resume(_req):
        was_paused = _is_paused()
        _set_pause_until(0.0)
        return {"ok": True, "paused": False, "was_paused": was_paused}

    server.register("run", cmd_run)
    server.register("reload", cmd_reload)
    server.register("restart", cmd_restart)
    server.register("status", cmd_status)
    server.register("pull", cmd_pull)
    server.register("list_schedule", cmd_list_schedule)
    server.register("set_schedule", cmd_set_schedule)
    server.register("remove_schedule", cmd_remove_schedule)
    server.register("get_removal_mode", cmd_get_removal_mode)
    server.register("set_removal_mode", cmd_set_removal_mode)
    server.register("list_extensions", cmd_list_extensions)
    server.register("disable_extension", cmd_disable_extension)
    server.register("enable_extension", cmd_enable_extension)
    server.register("run_history", cmd_run_history)
    server.register("logs", cmd_logs)
    server.register("queue_peek", cmd_queue_peek)
    server.register("queue_clear", cmd_queue_clear)
    server.register("restart_workers", cmd_restart_workers)
    server.register("stats", cmd_stats)
    server.register("config_show", cmd_config_show)
    server.register("config_set", cmd_config_set)
    server.register("mdauth_status", cmd_mdauth_status)
    server.register("force_login", cmd_force_login)
    server.register("logout", cmd_logout)
    server.register("pause", cmd_pause)
    server.register("resume", cmd_resume)
    server.start()
    return server


def _run_pull_job(database_connection, payload: dict) -> None:
    """Pull the named repos and, if any changed, reload so the new extension
    code is picked up — without a full process restart. Used by the webhook's
    extension-push path. `payload["repos"]` holds slot names understood by
    PubloaderUpdater.update_one ('extensions', 'extensions-private')."""
    repos = payload.get("repos") or []
    try:
        updater = PubloaderUpdater()
    except Exception:
        logger.exception("pull job: updater init failed")
        return

    changed = False
    for name in repos:
        try:
            status = updater.update_one(name)
        except Exception:
            logger.exception(f"pull job: pulling {name!r} failed")
            continue
        if status.get("changed"):
            changed = True
            logger.info(f"pull job: {name!r} updated to {status.get('sha')}.")
        elif not status.get("ok"):
            logger.warning(f"pull job: {name!r} pull failed: {status.get('error')}")

    if changed:
        # Re-import extension modules to activate the new code. Mirrors /reload:
        # general_run=False means only extensions already due now actually run.
        main(
            database_connection=database_connection,
            extension_names=None,
            general_run=False,
            clean_db=False,
        )


def _drain_ipc_jobs(database_connection) -> None:
    """Pull queued IPC jobs and execute them. Called from the main loop."""
    while True:
        try:
            kind, payload = _ipc_jobs.get_nowait()
        except queue.Empty:
            return

        try:
            if kind == JOB_RUN:
                main(database_connection=database_connection, **payload)
            elif kind == JOB_RESTART:
                restart()
            elif kind == JOB_PULL:
                _run_pull_job(database_connection, payload)
            else:
                logger.warning(f"Unknown IPC job kind: {kind!r}")
        except Exception:
            logger.exception(f"IPC job {kind!r} failed")


def _build_dispatch_payload(vargs: dict) -> dict:
    extension = vargs.get("extension")
    if extension:
        extensions = [str(e).strip() for e in extension]
    else:
        extensions = None
    return {
        "extensions": extensions,
        "force": bool(vargs.get("force")),
        "clean": bool(vargs.get("clean")),
    }


def _dispatch_to_running_instance(vargs: dict) -> int:
    """Forward a CLI invocation to the running instance over IPC. Returns exit code."""
    if vargs.get("update"):
        result = ipc_call("restart")
    else:
        result = ipc_call("run", **_build_dispatch_payload(vargs))
    print(f"Dispatched to running instance: {result}")
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--clean",
        "-c",
        default=False,
        const=True,
        nargs="?",
        help="Clean the database.",
    )
    parser.add_argument(
        "--force",
        "-f",
        default=False,
        const=True,
        nargs="?",
        help="Force run the bot, if extensions is unspecified, run all.",
    )
    parser.add_argument(
        "--extension",
        "-e",
        action="append",
        required=False,
        help="Run a specific extension.",
    )
    parser.add_argument(
        "--update",
        "-u",
        default=False,
        const=True,
        nargs="?",
        help="Update the bot.",
    )

    vargs = vars(parser.parse_args())

    # Single-instance gate — second invocations forward to the running one.
    if is_instance_running():
        sys.exit(_dispatch_to_running_instance(vargs))

    if vargs["update"]:
        restart()

    database_connection = get_database_connection()
    worker.main(database_connection)
    ipc_server = _setup_ipc_server(database_connection)
    webhook_listener = _start_webhook_listener()
    _start_heartbeat()
    _load_pause_until()

    if vargs["extension"] is None:
        extension_to_run = None
    else:
        extension_to_run = [str(extension).strip() for extension in vargs["extension"]]

    if vargs["force"] or vargs["clean"]:
        main(
            database_connection,
            extension_names=extension_to_run,
            general_run=vargs["force"],
            clean_db=vargs["clean"],
        )

    print(
        "--------------------------------------------------Starting scheduler--------------------------------------------------"
    )
    schedule = Scheduler(tzinfo=timezone.utc, max_exec=1)
    schedule.daily(
        dtTime(
            hour=0,
            minute=0,
            tzinfo=timezone.utc,
        ),
        restart,
        weight=9,
        alias="restarter",
        tags={"restarter"},
    )
    schedule.daily(
        dtTime(
            hour=daily_run_time_checks_hour,
            minute=daily_run_time_checks_minute,
            tzinfo=timezone.utc,
        ),
        main,
        weight=8,
        alias="daily_checker",
        tags={"daily_checker"},
        kwargs={
            "database_connection": database_connection,
        },
    )
    schedule_extensions(database_connection)
    print(schedule)

    try:
        while True:
            # Idempotent: reuses the live watchers and only respawns any that
            # have died, so the workers stay alive for the lifetime of the loop.
            worker.main(database_connection)
            # While paused, skip due scheduled jobs; manual /run is rejected at
            # the IPC layer, so nothing new enters the queue to drain either.
            if not _is_paused():
                schedule.exec_jobs()
            _drain_ipc_jobs(database_connection)
            time.sleep(1)
    except KeyboardInterrupt:
        ipc_server.stop()
        if webhook_listener is not None:
            webhook_listener.stop()
        worker.kill()
        sys.exit(1)
