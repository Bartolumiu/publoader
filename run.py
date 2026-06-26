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

# Holds (kind, payload) tuples; populated by IPC threads, drained on main thread.
_ipc_jobs: "queue.Queue" = queue.Queue()
_run_lock = threading.Lock()

# Extensions currently queued-but-not-yet-completed or actively executing.
# Used to reject duplicate /run /force / /clean for the same extension while
# one is in flight, so a re-trigger can't kick off the same extension twice.
_inflight_extensions: set = set()
_inflight_lock = threading.Lock()


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


def main(
    database_connection,
    extension_names: list[str] = None,
    general_run=False,
    clean_db=False,
):
    """Call the main function of the publoader bot."""
    from publoader import publoader

    reload(publoader)
    try:
        with _run_lock:
            publoader.open_extensions(
                database_connection,
                names=extension_names,
                general_run=general_run,
                clean_db=clean_db,
            )
    finally:
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


def _setup_ipc_server(database_connection) -> IPCServer:
    """Register handlers that enqueue jobs for the main loop to execute."""
    server = IPCServer()

    def cmd_run(req):
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
                {"extension_names": None, "general_run": False, "clean_db": False},
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
            schedule.exec_jobs()
            _drain_ipc_jobs(database_connection)
            time.sleep(1)
    except KeyboardInterrupt:
        ipc_server.stop()
        if webhook_listener is not None:
            webhook_listener.stop()
        worker.kill()
        sys.exit(1)
