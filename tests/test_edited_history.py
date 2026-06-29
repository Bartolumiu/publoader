"""Tests for the `edited` history collection (models/database.record_chapter_edit).

Every successful chapter edit appends an entry holding the old and new MangaDex
state to a single per-chapter document, so the same md_chapter_id accumulates
multiple changes over time in one `edits` array.
"""
import publoader.models.database as database


class FakeEditedCollection:
    """Minimal Mongo stand-in supporting update_one with upsert/$set/$push."""

    def __init__(self):
        self.docs = []

    @staticmethod
    def _value(cond):
        return cond["$eq"] if isinstance(cond, dict) and "$eq" in cond else cond

    def _match(self, query, doc):
        return all(doc.get(k) == self._value(v) for k, v in query.items())

    def update_one(self, query, update, upsert=False):
        doc = next((d for d in self.docs if self._match(query, d)), None)
        if doc is None:
            if not upsert:
                return
            doc = {k: self._value(v) for k, v in query.items()}
            self.docs.append(doc)
        for key, value in update.get("$set", {}).items():
            doc[key] = value
        for key, value in update.get("$push", {}).items():
            doc.setdefault(key, []).append(value)


class FakeDB:
    def __init__(self, collections):
        self._collections = collections

    def __getitem__(self, name):
        return self._collections[name]


def test_multiple_edits_accumulate_under_one_chapter():
    edited = FakeEditedCollection()
    db = FakeDB({"edited": edited})

    base = {
        "md_chapter_id": "c1",
        "md_manga_id": "m1",
        "extension_name": "ext",
        "chapter_title": "Title v1",
    }

    database.record_chapter_edit(
        db, dict(base), old_info={"title": "A"}, new_info={"title": "B"}
    )
    database.record_chapter_edit(
        db,
        {**base, "chapter_title": "Title v2"},
        old_info={"title": "B"},
        new_info={"title": "C"},
    )

    # One document for the chapter, with both edits recorded in order.
    assert len(edited.docs) == 1
    doc = edited.docs[0]
    assert doc["md_chapter_id"] == "c1"
    assert len(doc["edits"]) == 2
    assert doc["edits"][0]["old"] == {"title": "A"}
    assert doc["edits"][0]["new"] == {"title": "B"}
    assert doc["edits"][1]["old"] == {"title": "B"}
    assert doc["edits"][1]["new"] == {"title": "C"}
    assert all("edited_at" in entry for entry in doc["edits"])

    # Top-level mirrors the canonical chapter shape, refreshed to latest state.
    assert doc["chapter_title"] == "Title v2"
    assert doc["md_manga_id"] == "m1"
    assert "last_edited_at" in doc


def test_edit_records_drop_images_and_skip_null_chapter_id():
    edited = FakeEditedCollection()
    db = FakeDB({"edited": edited})

    # Page images are not part of the edit audit log.
    database.record_chapter_edit(
        db,
        {"md_chapter_id": "c2", "images": [b"\x00"], "chapter_title": "x"},
        old_info={"title": "A"},
        new_info={"title": "B"},
    )
    assert "images" not in edited.docs[0]

    # A chapter without an md_chapter_id can't be keyed, so it is skipped.
    database.record_chapter_edit(
        db, {"md_chapter_id": None}, old_info={}, new_info={}
    )
    assert len(edited.docs) == 1
