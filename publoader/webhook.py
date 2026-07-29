import logging
import threading
import time
from json import JSONDecodeError
from typing import Dict, List, Optional, Union

from discord_webhook import DiscordEmbed, DiscordWebhook

from publoader.models.dataclasses import Chapter
from publoader.utils.config import config
from publoader.utils.utils import EXPIRE_TIME, get_current_datetime

logger = logging.getLogger("webhook")


def _parse_webhook_urls(raw: Optional[str]) -> List[str]:
    """Accept a single URL, or comma/newline-separated list."""
    if not raw:
        return []
    parts = [chunk.strip() for chunk in raw.replace(",", "\n").splitlines()]
    return [p for p in parts if p]


webhook_urls: List[str] = _parse_webhook_urls(config["Paths"].get("webhook_url"))
# Back-compat alias — some external code may read this.
webhook_url = webhook_urls[0] if webhook_urls else None


def make_webhook():
    # Older discord_webhook releases don't actually iterate when `url` is a
    # list — they pass `str(list)` to requests and fail with InvalidSchema.
    # Always construct with a single URL; `send_webhook` fan-outs per-URL.
    return DiscordWebhook(
        url=webhook_urls[0] if webhook_urls else "",
        rate_limit_retry=True,
    )


webhook = make_webhook()
COLOUR = "B86F8C"

# Discord embed limits: the 6000 cap applies to the combined characters of
# every embed attached to a single message, not per embed.
EMBED_TOTAL_LIMIT = 6000
EMBED_TITLE_LIMIT = 256
EMBED_DESCRIPTION_LIMIT = 4096
EMBED_FIELD_NAME_LIMIT = 256
EMBED_FIELD_VALUE_LIMIT = 1024
EMBED_FOOTER_TEXT_LIMIT = 2048
EMBED_AUTHOR_NAME_LIMIT = 256
EMBED_MAX_FIELDS = 25
EMBEDS_PER_MESSAGE = 10
# Worst-case size of one truncated field; a fresh embed must leave this much
# headroom so at least one field always fits (guarantees splitting terminates).
_FIELD_BUDGET = EMBED_FIELD_NAME_LIMIT + EMBED_FIELD_VALUE_LIMIT


def _clip(text: Optional[str], limit: int) -> Optional[str]:
    if text is None or len(text) <= limit:
        return text
    if limit <= 0:
        return ""
    return text[: limit - 1] + "…"

# Thread-local guard so the error log handler can't recurse into itself when
# the webhook send path itself logs at ERROR.
_emit_guard = threading.local()


class WebhookHelper:
    def __init__(self, **kwargs) -> None:
        self.extension_name = kwargs.get("extension_name")
        self.colour = kwargs.get("colour") or COLOUR
        self.mangadex_chapter_url = "https://mangadex.org/chapter/{}"
        self.mangadex_manga_url = "https://mangadex.org/manga/{}"
        self.footer = (
            {
                "text": f"{'' if self.extension_name.startswith('extensions.') else 'extensions.'}{self.extension_name}"
            }
            if self.extension_name is not None
            else None
        )

    def _format_link(
        self,
        name: Optional[str] = None,
        url: Optional[str] = None,
        type: Optional[str] = None,
        skip_chapter_id: bool = False,
    ):
        if name is not None:
            name = name.title()

        if type is not None:
            type = type.lower()

        if skip_chapter_id or url is None:
            return ""

        return f"{name} {type} link: [here]({url})\n"

    def normalise_chapter(
        self,
        chapter: Union[Chapter, dict],
        failed_upload: bool = False,
        inline: bool = True,
        success: bool = False,
    ) -> Dict[str, str]:
        if isinstance(chapter, Chapter):
            chapter = vars(chapter)

        name = f"Success: {success}\nManga: {chapter.get('manga_name')}\nChapter: {chapter.get('chapter_number')}\nExtension: {chapter.get('extension_name')}"
        value = (
            f"Language: `{chapter.get('chapter_language')}`\n"
            f"Chapter title: `{chapter.get('chapter_title')}`\n"
            f"Chapter expiry: `{(chapter.get('chapter_expire') or EXPIRE_TIME).isoformat()}`\n"
            "\n"
            f"{self._format_link(name='MangaDex', type='chapter', url=self.mangadex_chapter_url.format(chapter.get('md_chapter_id')), skip_chapter_id=failed_upload)}"
            f"{self._format_link(name='MangaDex', type='manga', url=self.mangadex_manga_url.format(chapter.get('md_manga_id')), skip_chapter_id=failed_upload)}"
            "\n"
            f"{self._format_link(name=chapter.get('extension_name'), type='chapter', url=chapter.get('chapter_url'))}"
            f"{self._format_link(name=chapter.get('extension_name'), type='manga', url=chapter.get('manga_url'))}"
        )

        return {"name": name, "value": value, "inline": inline}

    def normalise_chapters(self, chapters, failed_upload: bool = False):
        normalised_chapters = [
            self.normalise_chapter(chapter, failed_upload) for chapter in chapters
        ]
        return [
            normalised_chapters[elem : elem + 25]
            for elem in range(0, len(normalised_chapters), 25)
        ]

    def make_embed(self, embed_data: Optional[dict] = None) -> DiscordEmbed:
        embed = DiscordEmbed(**embed_data, footer=self.footer)
        embed.set_title(embed_data.get("title", None))
        embed.set_description(embed_data.get("description", None))
        logger.debug(f"Made embed: {embed.title}, {embed.description}")
        return embed

    def add_fields_to_embed(
        self, embed: "DiscordEmbed", normalised_chapters: List[dict]
    ):
        logger.debug(f"Adding chapters to embed {embed.title}: {normalised_chapters}")
        for c in normalised_chapters:
            embed.add_embed_field(**c)

    @staticmethod
    def _embed_as_dict(embed: Union["DiscordEmbed", dict]) -> dict:
        if isinstance(embed, dict):
            return embed
        return dict(embed.__dict__)

    @staticmethod
    def _base_embed_size(embed_dict: dict) -> int:
        """Character count of everything except fields, per Discord's rules:
        title + description + footer.text + author.name."""
        embed_len = len(embed_dict.get("title") or "")
        embed_len += len(embed_dict.get("description") or "")
        footer = embed_dict.get("footer") or {}
        if isinstance(footer, dict):
            embed_len += len(footer.get("text") or "")
        author = embed_dict.get("author") or {}
        if isinstance(author, dict):
            embed_len += len(author.get("name") or "")
        return embed_len

    def _calculate_embed_size(self, embed: Union[DiscordEmbed, dict]) -> int:
        embed_dict = self._embed_as_dict(embed)
        embed_len = self._base_embed_size(embed_dict)
        for field in embed_dict.get("fields") or []:
            embed_len += len(field.get("name") or "") + len(field.get("value") or "")
        return embed_len

    @staticmethod
    def _truncated_copy(embed_dict: dict) -> dict:
        """Deep-enough copy with every component clipped to its Discord limit.
        Copies footer/author/fields so shared dicts (e.g. self.footer) are
        never mutated."""
        embed_dict = dict(embed_dict)
        embed_dict["title"] = _clip(embed_dict.get("title"), EMBED_TITLE_LIMIT)
        embed_dict["description"] = _clip(
            embed_dict.get("description"), EMBED_DESCRIPTION_LIMIT
        )

        footer = embed_dict.get("footer")
        if isinstance(footer, dict):
            footer = dict(footer)
            footer["text"] = _clip(footer.get("text"), EMBED_FOOTER_TEXT_LIMIT)
            embed_dict["footer"] = footer

        author = embed_dict.get("author")
        if isinstance(author, dict):
            author = dict(author)
            author["name"] = _clip(author.get("name"), EMBED_AUTHOR_NAME_LIMIT)
            embed_dict["author"] = author

        embed_dict["fields"] = [
            {
                **field,
                "name": _clip(field.get("name"), EMBED_FIELD_NAME_LIMIT),
                "value": _clip(field.get("value"), EMBED_FIELD_VALUE_LIMIT),
            }
            for field in embed_dict.get("fields") or []
        ]
        return embed_dict

    def _split_embed(self, embed: Union["DiscordEmbed", dict]) -> List[dict]:
        """Split one embed into as many embeds as needed so each stays within
        every Discord limit (per-component caps, 25 fields, and small enough
        that no single embed exceeds the 6000 total). Title, description,
        footer and colour are repeated on each continuation embed."""
        embed_dict = self._truncated_copy(self._embed_as_dict(embed))
        fields = embed_dict.pop("fields")
        base_len = self._base_embed_size(embed_dict)

        # The non-field content must leave headroom for at least one
        # worst-case field, otherwise no field could ever be placed. Clip the
        # description (the only unbounded-ish component) until it does.
        max_base = EMBED_TOTAL_LIMIT - (_FIELD_BUDGET if fields else 0)
        if base_len > max_base:
            description = embed_dict.get("description") or ""
            embed_dict["description"] = _clip(
                description, max(0, len(description) - (base_len - max_base))
            )
            base_len = self._base_embed_size(embed_dict)

        if not fields:
            return [{**embed_dict, "fields": []}]

        field_chunks: List[List[dict]] = [[]]
        current_len = base_len
        for field in fields:
            field_len = len(field.get("name") or "") + len(field.get("value") or "")
            if field_chunks[-1] and (
                len(field_chunks[-1]) >= EMBED_MAX_FIELDS
                or current_len + field_len > EMBED_TOTAL_LIMIT
            ):
                field_chunks.append([])
                current_len = base_len
            field_chunks[-1].append(field)
            current_len += field_len

        return [{**embed_dict, "fields": chunk} for chunk in field_chunks]

    def check_embeds_size(self, local_webhook: DiscordWebhook):
        """Replace every oversized embed with its split parts. Embeds are kept
        as plain dicts — the same representation DiscordWebhook.add_embed
        stores — so the payload stays JSON-serialisable."""
        split_embeds: List[dict] = []
        for embed in local_webhook.get_embeds():
            split_embeds.extend(self._split_embed(embed))
        local_webhook.embeds[:] = split_embeds

    def _batch_embeds(self, embeds: List[Union[DiscordEmbed, dict]]) -> List[list]:
        """Group embeds into messages of at most 10 embeds whose combined
        character count stays under the 6000 message-wide cap."""
        batches: List[list] = [[]]
        batch_len = 0
        for embed in embeds:
            embed_len = self._calculate_embed_size(embed)
            if batches[-1] and (
                len(batches[-1]) >= EMBEDS_PER_MESSAGE
                or batch_len + embed_len > EMBED_TOTAL_LIMIT
            ):
                batches.append([])
                batch_len = 0
            batches[-1].append(embed)
            batch_len += embed_len
        return [batch for batch in batches if batch]

    def send_webhook(self, local_webhook: DiscordWebhook = webhook):
        if not webhook_urls:
            return

        if not local_webhook.embeds:
            return

        self.check_embeds_size(local_webhook)

        embeds_split = self._batch_embeds(local_webhook.embeds)
        local_webhook.embeds.clear()

        for count, embed in enumerate(embeds_split, start=1):
            # Fan out the same batch to every configured URL. Re-assigning
            # embeds before each execute is required because remove_embeds=True
            # clears them after the first send.
            for url in webhook_urls:
                local_webhook.url = url
                local_webhook.embeds = list(embed)
                response = local_webhook.execute(remove_embeds=True)
                try:
                    if isinstance(response, list):
                        status_codes = [r.status_code for r in response]
                        messages = [r.json() for r in response]
                        logger.info(
                            f"Discord API returned for {url}: {status_codes}, {messages}"
                        )
                    else:
                        logger.info(
                            f"Discord API returned for {url}: "
                            f"{response.status_code}, {response.json()}"
                        )
                except (JSONDecodeError, AttributeError, KeyError) as e:
                    logger.error(e)

            if count < len(embeds_split):
                time.sleep(1)


class WebhookBase(WebhookHelper):
    def __init__(
        self,
        extension_name: str,
        manga: dict,
    ) -> None:
        super().__init__(extension_name=extension_name)
        self.manga = manga
        logger.debug(f"Making embed for manga {self.manga}")
        self.manga_id = manga.get("id", "Manga id not found")
        self.manga_title = manga.get("title", "Manga title not found")
        self.mangadex_manga_url = self.mangadex_manga_url.format(self.manga_id)


class PubloaderUpdatesWebhook(WebhookBase):
    def __init__(
        self,
        extension_name: str,
        manga: dict,
        chapters: List["Chapter"],
        failed_chapters: List["Chapter"],
        skipped: int,
        edited: int,
        clean_db: bool,
    ) -> None:
        super().__init__(extension_name, manga)

        self.chapters: List["Chapter"] = chapters
        self.failed_chapters = failed_chapters

        self.uploaded = len(chapters)
        self.failed = len(self.failed_chapters)
        self.skipped = skipped
        self.edited = edited
        self.clean_db = clean_db

        self.normalised_manga = self.normalise_manga(
            self.uploaded, self.failed, self.skipped, self.edited
        )
        self.normalised_chapters = self.normalise_chapters(self.chapters)
        self.normalised_failed_chapters = self.normalise_chapters(
            self.failed_chapters, failed_upload=True
        )

    def normalise_manga(
        self, chapter_count: int, failed: int, skipped: int, edited: int
    ) -> Dict[str, str]:
        return {
            "title": f"{self.manga_title}",
            "description": f"MangaDex manga link: [here]({self.mangadex_manga_url})\n"
            f"To Upload: {chapter_count}\n"
            f"Skipped: {skipped}\n"
            f"To Edit: {edited}",
            "timestamp": get_current_datetime().isoformat(),
            "color": self.colour,
        }

    def format_embed(self, chapters_to_use: List[List[dict]]):
        for chapter_list in chapters_to_use:
            embed = self.make_embed(self.normalised_manga)
            if self.extension_name:
                embed.footer = {"text": f"extensions.{self.extension_name}"}
            self.add_fields_to_embed(embed, chapter_list)

            if chapter_list:
                webhook.add_embed(embed)

            if len(webhook.embeds) >= 10 or len(embed.fields) >= 5:
                self.send_webhook()

    def main(self, last_manga: bool = True):
        if self.uploaded > 0 or self.failed > 0:
            self.send_webhook()

        if self.chapters:
            self.format_embed(self.normalised_chapters)
        if self.failed_chapters:
            self.format_embed(self.normalised_failed_chapters)
        if self.edited > 0:
            embed = self.make_embed(self.normalised_manga)
            webhook.add_embed(embed)
        if self.skipped > 0 and not self.clean_db:
            embed = self.make_embed(self.normalised_manga)
            webhook.add_embed(embed)

        if last_manga:
            embed = self.make_embed(
                {"title": "Finished Getting all chapter updates.", "color": self.colour}
            )
            webhook.add_embed(embed)

        if self.uploaded > 0 or self.failed > 0:
            self.send_webhook()
        else:
            if len(webhook.embeds) >= 10:
                webhook_embeds = [
                    webhook.embeds[elem : elem + 10]
                    for elem in range(0, len(webhook.embeds), 10)
                ]
                for embed_list in webhook_embeds:
                    webhook.embeds = embed_list
                    if len(webhook.embeds) >= 10:
                        self.send_webhook()

            if last_manga:
                self.send_webhook()


class PubloaderQueueWebhook(WebhookHelper):
    # Worker types that report a single end-of-queue count summary instead of an
    # embed per processed chapter (mirrors PubloaderNotIndexedWebhook). For these
    # a per-chapter card is noise — only the total matters.
    SUMMARY_ONLY = {"unavailable"}

    def __init__(self, worker_type: str, **kwargs) -> None:
        super().__init__(**kwargs)
        self.webhook = make_webhook()
        self.worker_type = worker_type.capitalize()
        self.fields = []
        self.processed_count = 0
        self.failed_count = 0

    def normalise_embed(self) -> Dict[str, str]:
        return {
            "title": self.worker_type,
            "timestamp": get_current_datetime().isoformat(),
            "color": self.colour,
        }

    def add_chapter(self, chapter: dict, processed: bool = True):
        if self.worker_type.lower() in self.SUMMARY_ONLY:
            # Don't build an embed per chapter — just tally for send_summary().
            if processed:
                self.processed_count += 1
            else:
                self.failed_count += 1
            return

        if self.worker_type.lower() in ["uploader", "deleter"]:
            if self.worker_type.lower() == "uploader" and not processed:
                pass
            else:
                return

        self.fields.append(self.normalise_chapter(chapter, success=processed))

        if len(self.fields) >= 6:
            embed = self.make_embed(self.normalise_embed())
            self.add_fields_to_embed(embed, self.fields)

            self.webhook.add_embed(embed)
            self.send_webhook(self.webhook)

            self.fields[:] = []

    def send_summary(self):
        """Send a single count summary for SUMMARY_ONLY workers, then reset.

        Called when the queue drains (workers/watcher.py). A no-op for every
        other worker type and when nothing was processed, so it's safe to call
        unconditionally after each drain."""
        if self.worker_type.lower() not in self.SUMMARY_ONLY:
            return
        if not (self.processed_count or self.failed_count):
            return

        description = f"Marked unavailable: {self.processed_count}"
        if self.failed_count:
            description += f"\nFailed: {self.failed_count}"

        embed = self.make_embed(
            {
                "title": f"{self.processed_count} chapters marked unavailable",
                "description": description,
                "color": self.colour,
            }
        )
        self.webhook.add_embed(embed)
        self.send_webhook(self.webhook)

        self.processed_count = 0
        self.failed_count = 0

    def send_queue_finished(self):
        embed_last = self.make_embed(
            {
                "title": f"{self.worker_type}: Finished all items in queue",
                "color": self.colour,
            }
        )
        self.fields[:] = []

        self.webhook.add_embed(embed_last)
        self.send_webhook(self.webhook)


class PubloaderDupesWebhook(WebhookBase):
    def __init__(self, extension_name: str, manga: Optional[dict] = None) -> None:
        self.extension_name = extension_name
        self.normalised_manga = None
        self.manga = manga
        if manga is not None:
            self.init_manga(manga)

        self.chapters = []

    def init_manga(self, manga: Optional[dict]):
        if manga is not None:
            super().__init__(self.extension_name, manga)
            self.colour = "C8AA69"
            self.normalised_manga = self.normalise_manga()

    def normalise_manga(self) -> Dict[str, str]:
        return {
            "title": f"Dupes in: {self.manga_title}",
            "description": f"""MangaDex manga link: [here]({self.mangadex_manga_url})""",
            "timestamp": get_current_datetime().isoformat(),
            "color": self.colour,
        }

    def add_chapters(self, main_chapter: dict, chapters: List[dict]):
        self.chapters.append(
            {
                "name": f"Dupes of chapter: {main_chapter['id']}\n"
                f"Chapter Number: {main_chapter['attributes']['chapter']}\n"
                f"Chapter Language: {main_chapter['attributes']['translatedLanguage']}",
                "value": self.normalise_chapters(chapters),
            }
        )

    def add_chapter(self, chapters: List[dict]):
        self.chapters.append(
            {
                "name": f"Dupes",
                "value": self.normalise_chapters(chapters),
            }
        )

    def normalise_chapters(self, chapters: List[dict]) -> str:
        return "\n".join([f'`{chapter["id"]}`' for chapter in chapters])

    def main(self):
        if self.normalised_manga is not None:
            logger.info(self.normalised_manga)
            embed = self.make_embed(self.normalised_manga)
            self.add_fields_to_embed(embed, self.chapters)
            logger.info(self.chapters)

            if self.chapters:
                webhook.add_embed(embed)
                self.send_webhook()


class PubloaderNotIndexedWebhook(WebhookHelper):
    def __init__(
        self,
        extension_name: str,
        chapters_not_indexed: List[str],
        chapters_indexed: int,
    ) -> None:
        super().__init__(extension_name=extension_name)
        self.chapters_not_indexed = chapters_not_indexed
        self.chapters_indexed = chapters_indexed
        self.colour = "45539B"

    def make_embed(self, **embed_data):
        embed = DiscordEmbed(
            title=embed_data["title"],
            description=embed_data["description"],
            **{
                "color": self.colour,
                "timestamp": get_current_datetime().isoformat(),
            },
            footer=self.footer,
        )

        logger.debug(f"Made embed: {embed.title}, {embed.description}")
        return embed

    def main(self):
        title = (
            f"{len(self.chapters_not_indexed)} chapters not indexed:"
            if self.chapters_not_indexed
            else f"{self.chapters_indexed} chapters indexed"
        )
        description = (
            "```" + "\n".join(self.chapters_not_indexed) + "```"
            if self.chapters_not_indexed
            else None
        )

        description = ("\n" + description) if description else None

        embed = self.make_embed(title=title, description=description)
        webhook.add_embed(embed)
        self.send_webhook()


class PubloaderWebhook(WebhookHelper):
    def __init__(self, extension_name: str, **kwargs) -> None:
        super().__init__(extension_name=extension_name)
        self.embed = None
        self.embed_title = kwargs.get("title")
        self.embed_description = kwargs.get("description")
        self.embed_colour = kwargs.get("colour")
        self.footer = kwargs.get("footer", self.footer)
        self.timestamp = kwargs.get("timestamp", get_current_datetime().isoformat())
        self.add_timestamp = kwargs.get("add_timestamp", True)

    def main(self, **kwargs):
        self.embed = DiscordEmbed(
            title=self.embed_title,
            description=self.embed_description,
            color=self.embed_colour or self.colour,
            footer=self.footer,
        )

        if self.add_timestamp:
            self.embed.timestamp = self.timestamp
        webhook.add_embed(self.embed)

        if len(webhook.embeds) >= 5:
            self.send_webhook()

    def send(self, **kwargs):
        self.main()
        self.send_webhook()


class WebhookLogHandler(logging.Handler):
    """Logging handler that fires a webhook (or bot notification) on every
    ERROR-level (or higher) log record. Re-entrancy is guarded so that a
    failure inside the webhook send path doesn't loop back into itself."""

    def __init__(self, level: int = logging.ERROR):
        super().__init__(level=level)
        # Quieter formatter — record content goes inside a code block on Discord.
        self.setFormatter(
            logging.Formatter("%(asctime)s [%(name)s] %(levelname)s: %(message)s")
        )

    def emit(self, record: logging.LogRecord) -> None:
        if getattr(_emit_guard, "active", False):
            return
        if record.name in ("webhook", "discord_webhook"):
            return
        if not webhook_urls:
            return
        _emit_guard.active = True
        try:
            msg = self.format(record)
            title = f"{record.levelname}: {record.name}"
            description = f"```\n{msg[:1800]}\n```"
            PubloaderWebhook(
                extension_name=None,
                title=title,
                description=description,
                colour="FF0000",
            ).send()
        except Exception:
            self.handleError(record)
        finally:
            _emit_guard.active = False


def attach_error_webhook_handler(logger_name: str = "publoader") -> None:
    """Attach the error-firing handler to a logger. Idempotent."""
    target = logging.getLogger(logger_name)
    if any(isinstance(h, WebhookLogHandler) for h in target.handlers):
        return
    target.addHandler(WebhookLogHandler())


if __name__ == "__main__":
    print("Please run this file through the bot.")
