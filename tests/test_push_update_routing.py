"""Tests for how webhook pushes are routed to update jobs in run.py.

Base-repo pushes take the full restart path; extension-repo pushes take the
lighter pull+reload path. These tests drain the module-level job queue to
assert routing without touching GitHub or the scheduler loop."""
import queue
from unittest.mock import patch, MagicMock

import run as run_module


def _drain():
    jobs = []
    while True:
        try:
            jobs.append(run_module._ipc_jobs.get_nowait())
        except queue.Empty:
            return jobs


def setup_function(_):
    # Start each test with an empty queue so drained jobs are unambiguous.
    _drain()


def test_base_push_queues_restart():
    run_module._enqueue_push_update("base", {"after": "deadbeefcafe"})
    assert _drain() == [(run_module.JOB_RESTART, {})]


def test_extension_push_queues_targeted_pull():
    run_module._enqueue_push_update("extensions", {"after": "deadbeefcafe"})
    assert _drain() == [(run_module.JOB_PULL, {"repos": ["extensions"]})]


def test_private_extension_push_queues_targeted_pull():
    run_module._enqueue_push_update("extensions-private", {"after": "abc123"})
    assert _drain() == [(run_module.JOB_PULL, {"repos": ["extensions-private"]})]


def test_pull_job_reloads_only_when_a_repo_changed():
    class _FakeUpdater:
        def update_one(self, name):
            return {"ok": True, "changed": True, "sha": "newsha"}

    db = MagicMock()
    with patch.object(run_module, "PubloaderUpdater", return_value=_FakeUpdater()), \
            patch.object(run_module, "main") as fake_main:
        run_module._run_pull_job(db, {"repos": ["extensions"]})

    fake_main.assert_called_once_with(
        database_connection=db,
        extension_names=None,
        general_run=False,
        clean_db=False,
    )


def test_pull_job_skips_reload_when_nothing_changed():
    class _FakeUpdater:
        def update_one(self, name):
            return {"ok": True, "changed": False, "sha": "samesha"}

    with patch.object(run_module, "PubloaderUpdater", return_value=_FakeUpdater()), \
            patch.object(run_module, "main") as fake_main:
        run_module._run_pull_job(MagicMock(), {"repos": ["extensions"]})

    fake_main.assert_not_called()


def test_pull_job_survives_update_one_failure():
    class _FakeUpdater:
        def update_one(self, name):
            raise RuntimeError("network down")

    with patch.object(run_module, "PubloaderUpdater", return_value=_FakeUpdater()), \
            patch.object(run_module, "main") as fake_main:
        run_module._run_pull_job(MagicMock(), {"repos": ["extensions"]})

    fake_main.assert_not_called()
