import logging
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

from publoader.http.properties import RequestError
from publoader.models.database import enqueue_chapter_removal
from publoader.models.dataclasses import Chapter
from publoader.utils.config import mangadex_api_url
from publoader.utils.utils import get_current_datetime

logger = logging.getLogger("publoader-deleter")


class DeleteProcess:
    def __init__(
        self,
        upload_chapter: dict,
        http_client,
        **kwargs,
    ):
        self.upload_chapter = upload_chapter
        self.http_client = http_client
        self.chapter = Chapter(**self.upload_chapter)
        self.extension_name = self.chapter.extension_name

    def delete_chapter(
        self,
    ) -> bool:
        """Check if the chapters expired and remove off mangadex if they are."""
        md_chapter_id: Optional[str] = self.chapter.md_chapter_id
        deleted_message = f"{md_chapter_id}: {self.chapter.chapter_id}, manga {self.chapter.manga_id}, chapter {self.chapter.chapter_number}, language {self.chapter.chapter_language}."

        if md_chapter_id is not None:
            try:
                delete_reponse = self.http_client.delete(
                    f"{mangadex_api_url}/chapter/{md_chapter_id}"
                )
            except RequestError as e:
                logger.error(e)
                return False

            if delete_reponse.status_code == 200:
                logger.info(f"Deleted {self.chapter}.")
                print(f"--Deleted {deleted_message}")
                return True

        logger.error(f"Couldn't delete expired chapter {deleted_message}")
        print(f"Couldn't delete chapter {deleted_message}")
        return False


def run(item, http_client, queue_webhook, database_connection, **kwargs):
    chapter_deleter = DeleteProcess(item, http_client)
    deleted = chapter_deleter.delete_chapter()

    queue_webhook.add_chapter(item, processed=deleted)
    if deleted:
        database_connection["to_delete"].delete_one({"_id": {"$eq": item["_id"]}})
        database_connection["uploaded"].delete_one({"_id": {"$eq": item["_id"]}})
        item.pop("_id")
        database_connection["deleted"].insert_one(item)


def sweep_expired_chapters(database_connection):
    """Route time-expired uploaded chapters through the removal pipeline.

    A chapter only carries a `chapter_expire` date if its extension set one.
    Once that date passes we no longer hard-delete it here; instead we hand it
    to enqueue_chapter_removal, which honours the configured removal mode —
    either a hard delete (to_delete) or replacing the chapter with an
    "unavailable" card (to_unavailable). enqueue_chapter_removal also pulls the
    rows out of `uploaded`, so the next sweep won't pick them up again.

    The mode is resolved from the global setting only (extension=None): the
    deleter runs in its own subprocess without loaded extension instances, so
    per-extension `chapter_removal_mode` overrides don't apply to the
    time-expiry path — only the global setting (controlled via the bot) does.
    """
    expired = list(
        database_connection["uploaded"].find(
            {"chapter_expire": {"$lte": get_current_datetime()}}
        )
    )
    if not expired:
        return

    # enqueue_chapter_removal works per (extension, manga); group accordingly.
    grouped: Dict[Tuple[Optional[str], Optional[str]], List[dict]] = defaultdict(list)
    for chap in expired:
        # `_id` is immutable and would break the upsert into the removal queue.
        chap.pop("_id", None)
        grouped[(chap.get("extension_name"), chap.get("md_manga_id"))].append(chap)

    for (extension_name, md_manga_id), chapters in grouped.items():
        if not md_manga_id:
            logger.warning(
                f"Skipping {len(chapters)} expired chapter(s) with no md_manga_id "
                f"(extension={extension_name})."
            )
            continue
        enqueue_chapter_removal(
            database_connection=database_connection,
            extension_name=extension_name,
            md_manga_id=md_manga_id,
            chapter=chapters,
        )


def fetch_data_from_database(database_connection):
    # Expired chapters are routed into to_delete / to_unavailable by the sweep;
    # this worker then only drains the to_delete queue.
    try:
        sweep_expired_chapters(database_connection)
    except Exception:
        logger.exception("Expired-chapter sweep failed; draining to_delete only.")

    return list(database_connection["to_delete"].find())
