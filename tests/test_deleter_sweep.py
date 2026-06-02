"""Tests for the deleter worker's expired-chapter sweep (workers/deleter.py).

The sweep must no longer hard-delete expired chapters directly. Instead it
routes them through enqueue_chapter_removal so the configured removal mode
decides between a hard delete and replacing the chapter with an unavailable
card. fetch_data_from_database should then only return the to_delete backlog.
"""
import publoader.workers.deleter as deleter


class FakeCollection:
    def __init__(self, docs=None):
        self.docs = list(docs or [])

    def find(self, query=None):
        return [dict(d) for d in self.docs]


class FakeDB:
    def __init__(self, collections):
        self._collections = collections

    def __getitem__(self, name):
        return self._collections[name]


def test_sweep_routes_expired_through_enqueue(monkeypatch):
    expired = [
        {"_id": "oid1", "extension_name": "ext", "md_manga_id": "m1",
         "md_chapter_id": "c1", "chapter_url": "https://x/1"},
        {"_id": "oid2", "extension_name": "ext", "md_manga_id": "m1",
         "md_chapter_id": "c2", "chapter_url": "https://x/2"},
        {"_id": "oid3", "extension_name": "ext2", "md_manga_id": "m2",
         "md_chapter_id": "c3", "chapter_url": "https://x/3"},
    ]
    db = FakeDB(
        {
            "uploaded": FakeCollection(expired),
            "to_delete": FakeCollection([{"_id": "d1", "md_chapter_id": "old"}]),
        }
    )

    calls = []
    monkeypatch.setattr(
        deleter, "enqueue_chapter_removal", lambda **kwargs: calls.append(kwargs)
    )

    result = deleter.fetch_data_from_database(db)

    # One enqueue per (extension, manga) group.
    assert len(calls) == 2
    by_manga = {c["md_manga_id"]: c for c in calls}
    assert set(by_manga) == {"m1", "m2"}
    assert by_manga["m1"]["extension_name"] == "ext"
    assert len(by_manga["m1"]["chapter"]) == 2
    assert len(by_manga["m2"]["chapter"]) == 1
    # _id is stripped so the upsert into the removal queue can't hit the
    # immutable-field error.
    assert all("_id" not in ch for ch in by_manga["m1"]["chapter"])
    # No explicit mode is forced — enqueue resolves the configured removal mode.
    assert "mode" not in by_manga["m1"]

    # Expired uploaded docs are no longer returned for direct deletion; only the
    # to_delete backlog comes back.
    assert result == [{"_id": "d1", "md_chapter_id": "old"}]


def test_sweep_skips_chapters_without_manga_id(monkeypatch):
    db = FakeDB(
        {
            "uploaded": FakeCollection(
                [{"_id": "o", "extension_name": "ext", "md_manga_id": None,
                  "md_chapter_id": "c"}]
            ),
            "to_delete": FakeCollection([]),
        }
    )
    calls = []
    monkeypatch.setattr(
        deleter, "enqueue_chapter_removal", lambda **kwargs: calls.append(kwargs)
    )

    result = deleter.fetch_data_from_database(db)

    assert calls == []
    assert result == []


def test_sweep_failure_still_drains_to_delete(monkeypatch):
    uploaded = FakeCollection([])

    def boom(query=None):
        raise RuntimeError("db down")

    uploaded.find = boom
    db = FakeDB({"uploaded": uploaded, "to_delete": FakeCollection([{"_id": "d1"}])})

    # The sweep error is swallowed so the deleter still drains its queue.
    result = deleter.fetch_data_from_database(db)

    assert result == [{"_id": "d1"}]
