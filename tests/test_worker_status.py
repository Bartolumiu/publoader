"""Tests for per-worker queue-depth reporting in the IPC ``status`` command.

These are intentionally self-contained — they exercise ``run._worker_queue_lengths``
directly with a tiny fake Mongo database so they don't depend on a live MongoDB
or the socket round-trip.
"""
import run
from publoader.workers import worker


class _FakeCollection:
    def __init__(self, count):
        self._count = count

    def count_documents(self, _filter):
        return self._count


class _FakeDB:
    """Minimal pymongo-Database stand-in: ``db[name].count_documents({})``."""

    def __init__(self, counts):
        self._counts = counts

    def __getitem__(self, name):
        return _FakeCollection(self._counts.get(name, 0))


def test_worker_queue_lengths_reports_each_worker():
    counts = {"to_upload": 3, "to_delete": 1, "to_edit": 0, "to_unavailable": 5}
    workers = run._worker_queue_lengths(_FakeDB(counts))

    by_name = {w["name"]: w for w in workers}
    assert set(by_name) == {"uploader", "deleter", "editor", "unavailable"}
    assert by_name["uploader"]["queued"] == 3
    assert by_name["deleter"]["queued"] == 1
    assert by_name["editor"]["queued"] == 0
    assert by_name["unavailable"]["queued"] == 5
    # Each entry names the collection it counted.
    assert by_name["uploader"]["table"] == "to_upload"


def test_worker_queue_lengths_track_watcher_config():
    """The status report must stay in lockstep with the spawned watchers."""
    workers = run._worker_queue_lengths(_FakeDB({}))
    assert [w["name"] for w in workers] == [w["name"] for w in worker.WATCHERS]
    assert [w["table"] for w in workers] == [w["table"] for w in worker.WATCHERS]


def test_worker_queue_lengths_degrade_on_db_error():
    class _BoomDB:
        def __getitem__(self, name):
            raise RuntimeError("db down")

    workers = run._worker_queue_lengths(_BoomDB())
    assert len(workers) == len(worker.WATCHERS)
    assert all(w["queued"] is None for w in workers)
    assert all("error" in w for w in workers)
