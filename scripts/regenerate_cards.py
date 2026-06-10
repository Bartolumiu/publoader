"""Regenerate the chapter-card image on every chapter that already has one.

Why: older cards were rendered before format_title learned MangaDex's newer
title shape (romanised "{lang}-ro" title + English in altTitles), so some
read "Untitled". This re-renders the card for each affected chapter and
replaces its page in place, leaving externalUrl exactly as it is.

Two ways to find the targets:

  * --source md  (default): list every chapter uploaded by our account via the
    MangaDex API and keep those carrying the card signature — externalUrl set
    AND pages >= 1. This is self-contained (no DB needed) and authoritative for
    what actually has a card live on MangaDex. The publisher pill is taken from
    the chapter's scanlation group name.

  * --source db: same MangaDex discovery, then enrich each target from MongoDB
    (chapter_url / manga_url / extension_name, looked up by md_chapter_id across
    the unavailable / to_unavailable / uploaded / to_delete collections). This
    is what recovers the original publisher URL for chapters whose externalUrl
    was already dropped — needed for the card's SOURCE link and the externalUrl
    repoint. Run it where MongoDB (port 27017) is reachable.

The externalUrl is repointed exactly like the live worker: manga page > the
publisher's domain root > null. A chapter is only edited if it still carries the
card signature (pages >= 1), so we never touch a plain external chapter.

The regeneration mirrors workers/unavailable.py exactly (same card inputs,
same begin/upload/commit edit-session dance) but deliberately does NOT call the
externalUrl repoint step: the link was already settled when the card was first
made.

Usage (anywhere config.ini lives, e.g. inside the container):

    # Dry run — list what would change, touch nothing:
    python -m scripts.regenerate_cards

    # Actually regenerate and re-upload:
    python -m scripts.regenerate_cards --confirm

    # Limit / target specific chapters:
    python -m scripts.regenerate_cards --confirm --limit 10
    python -m scripts.regenerate_cards --confirm --chapter <md_chapter_id> ...
"""
from __future__ import annotations

import argparse
import sys
import time
from typing import List, Optional

from publoader.chapter_image import generate_chapter_card
from publoader.http import http_client
from publoader.http.properties import RequestError
from publoader.utils.config import mangadex_api_url
from publoader.workers.unavailable import UnavailableProcess


# Collections that may hold a chapter's original publisher URLs / publisher name,
# in priority order. `unavailable` is the archive the worker writes after a
# successful card upload, so it's the most authoritative.
_DB_LOOKUP_COLLECTIONS = ("unavailable", "to_unavailable", "uploaded", "to_delete")
_DB_ENRICH_FIELDS = (
    "chapter_url",
    "manga_url",
    "extension_name",
    "chapter_timestamp",
    "unavailable_at",
    "chapter_number",
    "chapter_title",
    "chapter_language",
)


def _enrich_targets_from_db(db, targets: List[dict]) -> int:
    """Fill chapter_url / manga_url / extension_name (etc.) on MD-discovered
    targets from MongoDB, looked up by md_chapter_id across the relevant
    collections. Returns how many targets got a usable chapter_url."""
    ids = [t["md_chapter_id"] for t in targets]
    found: dict = {}
    for coll in _DB_LOOKUP_COLLECTIONS:
        missing = [cid for cid in ids if cid not in found]
        if not missing:
            break
        for doc in db[coll].find({"md_chapter_id": {"$in": missing}}):
            found.setdefault(doc["md_chapter_id"], doc)

    enriched = 0
    for t in targets:
        doc = found.get(t["md_chapter_id"])
        if not doc:
            continue
        for field in _DB_ENRICH_FIELDS:
            value = doc.get(field)
            # Don't let a blank DB value clobber the MD-derived publisher name.
            if value is not None and (t.get(field) is None or field != "extension_name"):
                t[field] = value
        if t.get("chapter_url"):
            enriched += 1
    return enriched


def _card_targets_md(only: Optional[List[str]], limit: Optional[int]) -> List[dict]:
    """Scan our MangaDex uploads for chapters carrying the card signature.

    Returns lightweight item dicts (md_chapter_id + extension_name from the
    scanlation group) suitable for UnavailableProcess. The card inputs that
    matter are re-read from the live chapter at regeneration time."""
    me = http_client.get(f"{mangadex_api_url}/user/me")
    uid = (me.data or {}).get("data", {}).get("id")
    if not uid:
        raise SystemExit("Couldn't resolve our user id from /user/me")

    only_set = set(only) if only else None
    targets: List[dict] = []
    offset = 0
    while True:
        resp = http_client.get(
            f"{mangadex_api_url}/chapter",
            params={
                "uploader[]": [uid],
                "limit": 100,
                "offset": offset,
                "includes[]": ["scanlation_group"],
                "contentRating[]": ["safe", "suggestive", "erotica", "pornographic"],
                "order[createdAt]": "asc",
            },
        )
        data = (resp.data or {}).get("data", [])
        total = (resp.data or {}).get("total", 0)
        if not data:
            break
        for ch in data:
            attrs = ch.get("attributes") or {}
            if (attrs.get("pages") or 0) < 1:
                continue
            if only_set is not None and ch["id"] not in only_set:
                continue
            group = next(
                (
                    r
                    for r in ch.get("relationships", [])
                    if r.get("type") == "scanlation_group"
                ),
                None,
            )
            group_name = (group or {}).get("attributes", {}).get("name")
            targets.append(
                {"md_chapter_id": ch["id"], "extension_name": group_name}
            )
        offset += 100
        if offset >= total:
            break

    if limit is not None:
        targets = targets[:limit]
    return targets


def _has_card(attrs: dict) -> bool:
    """Card signature: a page is present. Our account only ever uploads cards
    (never real hosted pages), so any chapter of ours with pages >= 1 is a card,
    whether or not externalUrl was later dropped."""
    return (attrs.get("pages") or 0) >= 1


def regenerate_one(item: dict, *, confirm: bool) -> str:
    """Returns one of: regenerated | skipped-gone | skipped-nocard | failed."""
    proc = UnavailableProcess(item, http_client)
    cid = proc.md_chapter_id

    chapter_data = proc._fetch_md_chapter()
    if chapter_data is None:
        print(f"[skip] {cid}: gone from MangaDex")
        return "skipped-gone"

    attrs = chapter_data.get("attributes") or {}
    if not _has_card(attrs):
        print(
            f"[skip] {cid}: no card signature "
            f"(externalUrl={bool(attrs.get('externalUrl'))}, pages={attrs.get('pages')})"
        )
        return "skipped-nocard"

    name = proc._resolve_manga_name(chapter_data)
    chap_no = attrs.get("chapter") or proc.chapter.chapter_number
    # The publisher chapter link shown as SOURCE on the card: the live
    # externalUrl if it still has one, else whatever the queue row preserved.
    # (The MD field may have been repointed/dropped, but the card should keep
    # showing the original publisher chapter URL.)
    source_url = attrs.get("externalUrl") or proc.chapter.chapter_url
    if not source_url:
        # Without the original publisher URL the card would lose its SOURCE
        # link and we couldn't repoint correctly — refuse rather than degrade.
        print(
            f"[skip] {cid}: no source URL available (externalUrl dropped and none "
            f"in the queue row); run with --source db so chapter_url is present."
        )
        return "skipped-nourl"
    print(
        f"[plan] {cid}: '{name}' ch.{chap_no} ({attrs.get('translatedLanguage')}) "
        f"source={source_url}"
    )
    if not confirm:
        return "regenerated"  # counted as would-regenerate in dry run

    try:
        card_bytes = generate_chapter_card(
            manga_name=name,
            chapter_number=chap_no,
            chapter_title=attrs.get("title") or proc.chapter.chapter_title,
            chapter_language=attrs.get("translatedLanguage")
            or proc.chapter.chapter_language,
            extension_name=proc.chapter.extension_name,
            publisher=proc.chapter.extension_name,
            chapter_url=source_url,
            available_from=item.get("chapter_timestamp"),
            available_to=item.get("unavailable_at"),
        )
    except Exception as e:
        print(f"[fail] {cid}: card render failed: {e}")
        return "failed"

    proc.upload_session_id = proc._begin_edit_session(attrs.get("version"))
    if not proc.upload_session_id:
        print(f"[fail] {cid}: couldn't begin edit session")
        return "failed"

    page_id = proc._upload_card(card_bytes)
    if not page_id:
        proc._remove_upload_session()
        print(f"[fail] {cid}: card upload failed")
        return "failed"

    # Commit replaces the page with the freshly rendered card. _commit_page sends
    # the current externalUrl in the draft (omitting it when absent); the link is
    # (re)settled in the repoint step below.
    committed = proc._commit_page(attrs, page_id)
    if committed is None:
        proc._remove_upload_session()
        print(f"[fail] {cid}: commit failed")
        return "failed"

    # Repoint externalUrl exactly as the worker does: manga page > domain root >
    # null. _resolve_replacement_url falls back to a domain root derived from the
    # current externalUrl / queued chapter_url / manga_url, so even chapters whose
    # link was previously dropped get a useful landing point back.
    groups = [
        rel["id"]
        for rel in chapter_data.get("relationships", [])
        if rel.get("type") == "scanlation_group"
    ]
    version = (committed.get("attributes") or {}).get("version")
    if version is None:
        refetched = proc._fetch_md_chapter() or {}
        version = (refetched.get("attributes") or {}).get("version") or attrs.get(
            "version"
        )
    replacement_url = proc._resolve_replacement_url(attrs)
    if not proc._set_external_url(attrs, groups, version, replacement_url):
        print(f"[fail] {cid}: card replaced but externalUrl repoint failed")
        return "failed"

    print(
        f"[ok  ] {cid}: regenerated card for '{name}' "
        f"(externalUrl -> {replacement_url or 'cleared'})"
    )
    return "regenerated"


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--confirm",
        action="store_true",
        help="Actually regenerate & re-upload (default is a dry run).",
    )
    ap.add_argument("--limit", type=int, default=None, help="Cap number of chapters.")
    ap.add_argument(
        "--chapter",
        action="append",
        dest="chapters",
        help="Restrict to specific md_chapter_id(s); repeatable.",
    )
    ap.add_argument(
        "--source",
        choices=["md", "db"],
        default="md",
        help="md (default): find cards via MangaDex uploads only — chapters whose "
        "externalUrl was dropped are skipped (no source URL to show/repoint). "
        "db: same MangaDex discovery, then enrich each from MongoDB "
        "(chapter_url/manga_url/extension_name) so every card can be fixed. "
        "Run db where Mongo (port 27017) is reachable.",
    )
    ap.add_argument(
        "--sleep",
        type=float,
        default=0.0,
        help="Extra seconds to pause between chapters (http client already rate-limits).",
    )
    args = ap.parse_args(argv)

    # Both sources discover cards via the authenticated MangaDex feed.
    http_client.login()
    targets = _card_targets_md(args.chapters, args.limit)
    print(f"Found {len(targets)} card chapter(s) among our MangaDex uploads.")
    if not targets:
        return 0

    if args.source == "db":
        from publoader.models.database import get_database_connection

        db = get_database_connection()
        enriched = _enrich_targets_from_db(db, targets)
        print(
            f"Enriched {enriched}/{len(targets)} target(s) with a publisher URL "
            "from MongoDB."
        )

    if not args.confirm:
        print("DRY RUN — no changes will be made. Re-run with --confirm to apply.\n")

    counts: dict = {}
    for i, item in enumerate(targets, 1):
        print(f"--- [{i}/{len(targets)}] ---")
        try:
            result = regenerate_one(item, confirm=args.confirm)
        except RequestError as e:
            print(f"[fail] {item.get('md_chapter_id')}: request error: {e}")
            result = "failed"
        except Exception as e:
            print(f"[fail] {item.get('md_chapter_id')}: unexpected: {e}")
            result = "failed"
        counts[result] = counts.get(result, 0) + 1
        if args.confirm and args.sleep:
            time.sleep(args.sleep)

    print("\n=== summary ===")
    for k in (
        "regenerated",
        "skipped-gone",
        "skipped-nocard",
        "skipped-nourl",
        "failed",
    ):
        if k in counts:
            print(f"{k}: {counts[k]}")
    return 0 if counts.get("failed", 0) == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
