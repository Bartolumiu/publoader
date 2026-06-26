import logging
import multiprocessing

from publoader.workers import watcher

logger = logging.getLogger("publoader")

# Single source of truth for the worker subprocesses and the MongoDB collection
# each one drains. Imported by the IPC `status` handler so `/status` and `/ping`
# can report per-worker queue depth.
WATCHERS = [
    {"name": "uploader", "table": "to_upload", "colour": "26D454"},
    {"name": "deleter", "table": "to_delete", "colour": "C43542"},
    {"name": "editor", "table": "to_edit", "colour": "FFF71C"},
    {"name": "unavailable", "table": "to_unavailable", "colour": "9B9B9B"},
]

# Registry of the live watcher subprocesses, keyed by worker name. main() is the
# sole owner: it spawns each worker once and every later call reuses the same
# Process instance, respawning only the ones that have since died. This keeps the
# watchers singletons — a duplicate process draining the same collection would
# double-process every queued chapter.
_processes: dict = {}


def _spawn(worker, restart_threads):
    process = multiprocessing.Process(
        target=watcher.main,
        kwargs={
            "worker_type": worker["name"],
            "table_name": worker["table"],
            "webhook_colour": worker["colour"],
            "restart_threads": restart_threads,
        },
        daemon=True,
        name=f"watcher-{worker['name']}",
    )
    process.start()
    return process


def main(database_connection=None, restart_threads=True):
    """Ensure exactly one live watcher subprocess per worker.

    Idempotent and self-healing: the first call spawns the watchers, and every
    later call reuses the same Process instances, respawning only the ones that
    have since died. It never spawns a duplicate for a worker that is still
    alive, so it is safe to call from the main loop to keep the workers alive.

    `database_connection` is intentionally ignored for the children — pymongo's
    MongoClient is not fork-safe, so each watcher process opens its own.
    """
    try:
        for worker in WATCHERS:
            existing = _processes.get(worker["name"])
            if existing is not None and existing.is_alive():
                continue
            if existing is not None:
                logger.warning(f"Watcher {worker['name']} is not alive, respawning.")
            _processes[worker["name"]] = _spawn(worker, restart_threads)
    except KeyboardInterrupt:
        kill()


# The keep-alive contract is exactly what main() provides: spawn-if-missing,
# reuse-if-alive. Exposed under a clearer name for callers in the run loop.
ensure_alive = main


def kill():
    """Kill the sub-processes and forget the tracked instances."""
    print("Killing watcher processes.")

    for process in multiprocessing.active_children():
        process.terminate()
    _processes.clear()
