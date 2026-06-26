"""Normalise existing MongoDB documents to the canonical chapter schema.

Why: chapters were historically stored in two divergent shapes —

  * `to_upload` carried redundant top-level `mangadex_manga_id` /
    `mangadex_group_id` keys *alongside* the chapter's own `md_manga_id`, and
    never stored a group id on the chapter itself.
  * `to_edit` nested the whole chapter under a `chapter` key and kept the group
    id as a separate top-level `md_group_id`, while every other collection
    stores chapter fields flat at the top level.

The code now writes one canonical, flat shape everywhere: chapter fields at the
top level, with the MangaDex ids living on the chapter as `md_manga_id` /
`md_group_id`, plus clearly-named queue extras (`payload`, `images`,
`chapter_expire`, `unavailable_at`, `archived_at`). This script rewrites the
documents already sitting in the database to match.

It is idempotent: a document already in canonical shape is left untouched, so
re-running is safe (and reports 0 changes once everything is migrated).

Usage (anywhere config.ini lives, e.g. inside the container):

    # Dry run — report what would change, touch nothing:
    python -m scripts.normalize_db_schema

    # Actually migrate:
    python -m scripts.normalize_db_schema --confirm
"""
from __future__ import annotations

import argparse
from typing import Optional

from pymongo import ReplaceOne, UpdateOne

# Collections that store flat Chapter documents and may still carry the legacy
# top-level mangadex_* keys.
FLAT_CHAPTER_COLLECTIONS = [
    "to_upload",
    "uploaded",
    "to_delete",
    "to_unavailable",
    "unavailable",
    "deleted",
]

# Legacy top-level keys → canonical chapter field they map onto.
LEGACY_ID_KEYS = {
    "mangadex_manga_id": "md_manga_id",
    "mangadex_group_id": "md_group_id",
}


def _normalise_flat_doc(doc: dict) -> Optional[dict]:
    """Return a $set/$unset update for a flat chapter doc, or None if clean.

    Moves any legacy mangadex_* id onto its canonical md_* field (without
    clobbering a non-empty canonical value) and drops the legacy key.
    """
    set_fields = {}
    unset_fields = {}

    for legacy_key, canonical_key in LEGACY_ID_KEYS.items():
        if legacy_key not in doc:
            continue
        legacy_value = doc.get(legacy_key)
        if not doc.get(canonical_key) and legacy_value:
            set_fields[canonical_key] = legacy_value
        unset_fields[legacy_key] = ""

    if not set_fields and not unset_fields:
        return None

    update = {}
    if set_fields:
        update["$set"] = set_fields
    if unset_fields:
        update["$unset"] = unset_fields
    return update


def _flatten_to_edit_doc(doc: dict) -> Optional[dict]:
    """Return the canonical flat replacement for a nested to_edit doc, or None.

    Old shape: {_id, md_chapter_id, md_group_id, chapter: {...}, payload: {...}}
    New shape: {_id, ...chapter fields..., md_chapter_id, md_group_id, payload}
    """
    nested = doc.get("chapter")
    if not isinstance(nested, dict):
        # Already flat (no `chapter` wrapper) — nothing to do.
        return None

    flat = dict(nested)

    # Top-level ids are authoritative — they survived outside the wrapper.
    if doc.get("md_chapter_id") is not None:
        flat["md_chapter_id"] = doc["md_chapter_id"]
    if doc.get("md_group_id") is not None:
        flat["md_group_id"] = doc["md_group_id"]
    # Fall back to the manga id carried inside the nested chapter.
    flat.setdefault("md_manga_id", nested.get("md_manga_id"))

    flat["payload"] = doc.get("payload")
    flat["_id"] = doc["_id"]
    flat.pop("chapter", None)
    return flat


def migrate(database_connection, confirm: bool) -> None:
    total_changed = 0

    # --- Flat collections: drop legacy mangadex_* keys. ---
    for name in FLAT_CHAPTER_COLLECTIONS:
        collection = database_connection[name]
        ops = []
        for doc in collection.find(
            {"$or": [{key: {"$exists": True}} for key in LEGACY_ID_KEYS]}
        ):
            update = _normalise_flat_doc(doc)
            if update:
                ops.append(UpdateOne({"_id": doc["_id"]}, update))

        print(f"{name}: {len(ops)} document(s) need the legacy id keys normalised")
        total_changed += len(ops)
        if ops and confirm:
            collection.bulk_write(ops)

    # --- to_edit: flatten the nested `chapter` wrapper. ---
    to_edit = database_connection["to_edit"]
    edit_ops = []
    for doc in to_edit.find({"chapter": {"$exists": True}}):
        flat = _flatten_to_edit_doc(doc)
        if flat is not None:
            edit_ops.append(ReplaceOne({"_id": doc["_id"]}, flat))

    print(f"to_edit: {len(edit_ops)} document(s) need flattening")
    total_changed += len(edit_ops)
    if edit_ops and confirm:
        to_edit.bulk_write(edit_ops)

    if confirm:
        print(f"\nMigration applied — {total_changed} document(s) rewritten.")
    else:
        print(
            f"\nDry run — {total_changed} document(s) would change. "
            "Re-run with --confirm to apply."
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Apply the migration. Without this flag the script only reports.",
    )
    args = parser.parse_args()

    from publoader.models.database import get_database_connection

    database_connection = get_database_connection()
    migrate(database_connection, confirm=args.confirm)


if __name__ == "__main__":
    main()
