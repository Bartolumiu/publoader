"""Worker that processes the `to_unavailable` queue.

When a chapter lands here it still exists on MangaDex as an *external* chapter:
an `externalUrl` pointing at the publisher and no hosted pages. For each one we:

  1. Fetch the current chapter from MangaDex so we know its version, groups,
     language, etc.
  2. Generate a per-chapter info card image (publoader.chapter_image) — this is
     the only place cards are generated; uploads no longer create them eagerly.
  3. Open an *edit* upload session for the chapter
     (POST /upload/begin/{chapterId}), upload the card as the single page, and
     commit it (chapterDraft only accepts volume/chapter/title/language +
     externalUrl, so the link can't be dropped here).
  4. PUT /chapter/{id} with the full chapter body (the ChapterEdit schema
     requires volume, chapter, title, translatedLanguage, groups and version)
     and externalUrl repointed away from the now-dead chapter link: to the
     publisher's manga page if known, else the publisher's site root, else
     null (dropping the link entirely). See _resolve_replacement_url.
  5. On success, archive the row in the `unavailable` collection and remove
     it from `to_unavailable`.

Failures are left on the queue so they retry on the next scheduler tick.
"""

import logging
import traceback
from typing import Optional
from urllib.parse import urlparse

from publoader.chapter_image import generate_chapter_card
from publoader.http.properties import RequestError
from publoader.models.dataclasses import Chapter
from publoader.utils.config import mangadex_api_url, md_upload_api_url, upload_retry
from publoader.utils.misc import format_title
from publoader.utils.utils import get_current_datetime

logger = logging.getLogger("publoader-unavailable")


class UnavailableProcess:
    def __init__(self, item: dict, http_client, **kwargs):
        self.item = item
        self.http_client = http_client
        self.md_chapter_id: Optional[str] = item.get("md_chapter_id")
        self.chapter = Chapter(
            **{k: v for k, v in item.items() if k in Chapter.__dataclass_fields__}
        )
        self.upload_session_id: Optional[str] = None

    def _fetch_md_chapter(self):
        try:
            resp = self.http_client.get(
                f"{mangadex_api_url}/chapter/{self.md_chapter_id}",
                params={"includes[]": ["scanlation_group", "manga"]},
                successful_codes=[404],
            )
        except RequestError as e:
            logger.error(f"Couldn't fetch chapter {self.md_chapter_id}: {e}")
            return None

        if resp.status_code == 404 or resp.data is None:
            return None
        if resp.status_code != 200:
            return None
        return resp.data.get("data")

    def _resolve_manga_name(self, chapter_data: dict) -> Optional[str]:
        """Work out the series title to print on the card.

        The queue row's manga_name is frequently missing (it's only populated
        when the manga happened to be in the upload batch's metadata), which is
        why some cards rendered as "Untitled". The chapter fetch now pulls the
        manga relationship via includes[]=manga, so prefer that — run through
        format_title (handles the en/originalLanguage fallback) — and only fall
        back to whatever the row carried."""
        manga_rel = next(
            (
                rel
                for rel in chapter_data.get("relationships", [])
                if rel.get("type") == "manga"
            ),
            None,
        )
        if manga_rel and manga_rel.get("attributes"):
            try:
                return format_title(manga_rel)
            except Exception:
                logger.warning(
                    f"Couldn't format manga title from relationship for "
                    f"{self.md_chapter_id}; falling back to the queued name."
                )
        return self.chapter.manga_name

    def _delete_existing_upload_session(self):
        """MangaDex allows one upload session at a time; clear any stale one."""
        try:
            existing = self.http_client.get(
                f"{md_upload_api_url}", successful_codes=[404]
            )
        except RequestError as e:
            logger.error(f"Couldn't probe existing upload session: {e}")
            return

        if existing.status_code == 200 and existing.data is not None:
            self._remove_upload_session(existing.data["data"]["id"])

    def _remove_upload_session(self, session_id: Optional[str] = None):
        session_id = session_id or self.upload_session_id
        if not session_id:
            return
        try:
            self.http_client.delete(
                f"{md_upload_api_url}/{session_id}", successful_codes=[404]
            )
        except RequestError as e:
            logger.error(f"Couldn't delete upload session {session_id}: {e}")

    def _begin_edit_session(self, version: Optional[int]) -> Optional[str]:
        """Start an edit-chapter upload session for the existing chapter."""
        self._delete_existing_upload_session()
        try:
            resp = self.http_client.post(
                f"{md_upload_api_url}/begin/{self.md_chapter_id}",
                json={"version": version},
                tries=1,
            )
        except RequestError as e:
            logger.error(f"Couldn't begin edit session for {self.md_chapter_id}: {e}")
            return None

        if not resp.ok or resp.data is None:
            logger.error(
                f"Begin edit session for {self.md_chapter_id} returned "
                f"{resp.status_code}: {resp.data!r}"
            )
            return None
        return resp.data["data"]["id"]

    def _upload_card(self, card_bytes: bytes) -> Optional[str]:
        """Upload the generated card as the chapter's single page."""
        files = {"0": ("0.png", card_bytes, "image/png")}
        for _ in range(upload_retry):
            try:
                resp = self.http_client.post(
                    f"{md_upload_api_url}/{self.upload_session_id}", files=files
                )
            except RequestError as e:
                logger.error(f"Card upload failed for {self.md_chapter_id}: {e}")
                continue

            if resp.data is None:
                continue
            if resp.data.get("errors") or resp.data.get("result") == "error":
                logger.warning(f"Card upload reported errors: {resp.data}")
                continue

            try:
                return resp.data["data"][0]["id"]
            except (KeyError, IndexError):
                logger.warning(f"Unexpected card upload response: {resp.data}")
                continue
        return None

    def _commit_page(self, attrs: dict, page_id: str) -> Optional[dict]:
        """Attach the uploaded card to the chapter via the upload session.

        The `chapterDraft` schema (ChapterDraft) is strict — `additionalProperties:
        false`, required volume/chapter/title/translatedLanguage — and rejects
        `version`/`groups`, so we send only those plus the existing externalUrl.
        The publisher link is repointed/dropped separately in _set_external_url.
        Returns the committed chapter on success (its bumped version feeds the
        edit)."""
        payload = {
            "chapterDraft": {
                "volume": attrs.get("volume"),
                "chapter": attrs.get("chapter"),
                "title": attrs.get("title"),
                "translatedLanguage": attrs.get("translatedLanguage"),
                "externalUrl": attrs.get("externalUrl"),
            },
            "pageOrder": [page_id],
            "termsAccepted": True,
        }
        try:
            resp = self.http_client.post(
                f"{md_upload_api_url}/{self.upload_session_id}/commit", json=payload
            )
        except RequestError as e:
            logger.error(f"Commit failed for {self.md_chapter_id}: {e}")
            return None

        if resp.status_code != 200 or resp.data is None:
            logger.error(
                f"Commit returned {resp.status_code} for chapter "
                f"{self.md_chapter_id}: {resp.data!r}"
            )
            return None
        return resp.data.get("data")

    @staticmethod
    def _is_http_url(url: Optional[str]) -> bool:
        if not url:
            return False
        parsed = urlparse(url.strip())
        return parsed.scheme in ("http", "https") and bool(parsed.netloc)

    @classmethod
    def _domain_root(cls, url: Optional[str]) -> Optional[str]:
        """The scheme://host/ root of a URL, or None if it isn't a usable link."""
        if not cls._is_http_url(url):
            return None
        parsed = urlparse(url.strip())
        return f"{parsed.scheme}://{parsed.netloc}/"

    def _resolve_replacement_url(self, attrs: dict) -> Optional[str]:
        """Work out what externalUrl to leave on the chapter once it's gone.

        Rather than always dropping the publisher link, keep a useful landing
        point so readers can still find the series. Resolution order:

          1. The publisher's *manga* page (the queued manga_url), if it's a
             valid http(s) link.
          2. Otherwise the publisher's site root (scheme://host/) derived from
             any URL we have for this chapter — the live externalUrl, the
             queued chapter_url, then the manga_url.
          3. Otherwise None, dropping the link entirely as before.
        """
        manga_url = (self.chapter.manga_url or "").strip()
        if self._is_http_url(manga_url):
            return manga_url

        for candidate in (
            attrs.get("externalUrl"),
            self.chapter.chapter_url,
            self.chapter.manga_url,
        ):
            domain_root = self._domain_root(candidate)
            if domain_root:
                return domain_root

        return None

    def _set_external_url(
        self, attrs: dict, groups: list, version, new_url: Optional[str]
    ) -> bool:
        """Repoint (or drop) the publisher link via the chapter-edit endpoint.

        PUT /chapter/{id} (ChapterEdit) requires the full chapter body — volume,
        chapter, title, translatedLanguage, groups and version — so we resend all
        of it, only swapping externalUrl to `new_url` (None drops the link)."""
        payload = {
            "volume": attrs.get("volume"),
            "chapter": attrs.get("chapter"),
            "title": attrs.get("title"),
            "translatedLanguage": attrs.get("translatedLanguage"),
            "groups": groups,
            "externalUrl": new_url,  # manga page / site root / None
            "version": version,
        }
        try:
            resp = self.http_client.put(
                f"{mangadex_api_url}/chapter/{self.md_chapter_id}", json=payload
            )
        except RequestError as e:
            logger.error(f"Couldn't set externalUrl on {self.md_chapter_id}: {e}")
            return False

        if resp.status_code != 200:
            logger.error(
                f"Chapter edit returned {resp.status_code} for chapter "
                f"{self.md_chapter_id}: {resp.data!r}"
            )
            return False
        return True

    def mark_unavailable(self) -> bool:
        if not self.md_chapter_id:
            logger.error(f"Missing md_chapter_id on unavailable row: {self.item}")
            return False

        chapter_data = self._fetch_md_chapter()
        if chapter_data is None:
            # Either gone from MD already (treat as success → archive) or a
            # transient fetch failure. Distinguish via a follow-up HEAD-ish
            # probe so we don't archive on transient errors.
            try:
                probe = self.http_client.get(
                    f"{mangadex_api_url}/chapter/{self.md_chapter_id}",
                    successful_codes=[404],
                    tries=1,
                )
            except RequestError:
                return False
            if probe.status_code == 404:
                logger.info(
                    f"Chapter {self.md_chapter_id} already gone from MD; archiving."
                )
                return True
            return False

        attrs = chapter_data.get("attributes") or {}
        if not attrs.get("externalUrl"):
            # Already cleared (maybe a re-run). Treat as success.
            logger.info(
                f"Chapter {self.md_chapter_id} already has no externalUrl; archiving."
            )
            return True

        groups = [
            rel["id"]
            for rel in chapter_data.get("relationships", [])
            if rel.get("type") == "scanlation_group"
        ]

        # Generate the card now, at unavailability time, rather than at upload.
        try:
            card_bytes = generate_chapter_card(
                manga_name=self._resolve_manga_name(chapter_data),
                chapter_number=attrs.get("chapter") or self.chapter.chapter_number,
                chapter_title=attrs.get("title") or self.chapter.chapter_title,
                chapter_language=attrs.get("translatedLanguage")
                or self.chapter.chapter_language,
                extension_name=self.chapter.extension_name,
                publisher=self.chapter.extension_name,
                chapter_url=attrs.get("externalUrl") or self.chapter.chapter_url,
                available_from=self.item.get("chapter_timestamp"),
                available_to=self.item.get("unavailable_at"),
            )
        except Exception:
            traceback.print_exc()
            logger.exception(
                f"Couldn't generate chapter card for {self.md_chapter_id}; "
                "leaving on the queue to retry."
            )
            return False

        self.upload_session_id = self._begin_edit_session(attrs.get("version"))
        if not self.upload_session_id:
            return False

        page_id = self._upload_card(card_bytes)
        if not page_id:
            logger.error(f"Couldn't upload chapter card for {self.md_chapter_id}.")
            self._remove_upload_session()
            return False

        committed = self._commit_page(attrs, page_id)
        if committed is None:
            self._remove_upload_session()
            return False

        # The commit bumps the chapter version; PUT /chapter needs the current
        # one. Prefer the value the commit returned, re-fetching only if absent.
        version = (committed.get("attributes") or {}).get("version")
        if version is None:
            refetched = self._fetch_md_chapter() or {}
            version = (refetched.get("attributes") or {}).get("version") or attrs.get(
                "version"
            )

        replacement_url = self._resolve_replacement_url(attrs)
        if not self._set_external_url(attrs, groups, version, replacement_url):
            return False

        logger.info(
            f"Marked chapter {self.md_chapter_id} unavailable (uploaded card, "
            f"externalUrl -> {replacement_url or 'cleared'}; "
            f"extension={self.chapter.extension_name})."
        )
        return True


def run(item, http_client, queue_webhook, database_connection, **kwargs):
    proc = UnavailableProcess(item, http_client)
    success = proc.mark_unavailable()
    queue_webhook.add_chapter(item, processed=success)

    if not success:
        return

    # Archive the row before clearing it from the queue.
    archive_doc = dict(item)
    archive_doc.pop("_id", None)
    archive_doc["archived_at"] = get_current_datetime()
    try:
        database_connection["unavailable"].insert_one(archive_doc)
    except Exception:
        logger.exception(
            f"Failed to archive chapter {item.get('md_chapter_id')} into 'unavailable'"
        )
        return

    database_connection["to_unavailable"].delete_one({"_id": item["_id"]})


def fetch_data_from_database(database_connection):
    return list(database_connection["to_unavailable"].find())
