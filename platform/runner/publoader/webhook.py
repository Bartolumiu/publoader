"""Inert Discord webhook stubs.

Workers must never hold a Discord webhook URL — it is an operator credential
and an untrusted extension runs in the same process. Extensions that call these
classes (mangaplus does, to report per-run problems) keep working: every send
becomes a stderr log line, which the agent forwards to the operator's log
pipeline with the job id attached. Nothing reaches Discord from a worker; the
core notifies from the result envelope instead.
"""

import logging
from typing import Dict, List, Optional, Union

logger = logging.getLogger("webhook")

COLOUR = "B86F8C"


class WebhookHelper:
    def __init__(self, **kwargs) -> None:
        self.extension_name = kwargs.get("extension_name")
        self.colour = kwargs.get("colour") or COLOUR
        self.mangadex_chapter_url = "https://mangadex.org/chapter/{}"
        self.mangadex_manga_url = "https://mangadex.org/manga/{}"
        self.footer = None
        self.embed = None

    def normalise_chapter(self, chapter, **kwargs) -> Dict[str, str]:
        return {"name": "", "value": "", "inline": True}

    def normalise_chapters(self, chapters, failed_upload: bool = False) -> List[list]:
        return []

    def make_embed(self, embed_data: Optional[dict] = None):
        return None

    def add_embed(self, *args, **kwargs) -> None:
        return None

    def send_webhook(self, *args, **kwargs) -> None:
        return None

    def main(self, **kwargs) -> None:
        return None

    def send(self, **kwargs) -> None:
        self._log()

    def _log(self) -> None:
        logger.info(
            "webhook suppressed on worker: extension=%s title=%r description=%r",
            getattr(self, "extension_name", None),
            getattr(self, "embed_title", None),
            (getattr(self, "embed_description", None) or "")[:500],
        )


class WebhookBase(WebhookHelper):
    def __init__(self, extension_name: str, **kwargs) -> None:
        super().__init__(extension_name=extension_name, **kwargs)
        self.chapters = kwargs.get("chapters", [])


class PubloaderWebhook(WebhookHelper):
    def __init__(self, extension_name: str, **kwargs) -> None:
        super().__init__(extension_name=extension_name, **kwargs)
        self.embed_title = kwargs.get("title")
        self.embed_description = kwargs.get("description")
        self.embed_colour = kwargs.get("colour")
        self.timestamp = kwargs.get("timestamp")
        self.add_timestamp = kwargs.get("add_timestamp", True)


class PubloaderUpdatesWebhook(WebhookBase):
    pass


class PubloaderQueueWebhook(WebhookHelper):
    def __init__(self, extension_name: str = None, **kwargs) -> None:
        super().__init__(extension_name=extension_name, **kwargs)
        self.embed_title = kwargs.get("title")
        self.embed_description = kwargs.get("description")


class PubloaderDupesWebhook(WebhookBase):
    pass


class PubloaderNotIndexedWebhook(WebhookHelper):
    def __init__(self, extension_name: str = None, **kwargs) -> None:
        super().__init__(extension_name=extension_name, **kwargs)
        self.embed_title = kwargs.get("title")
        self.embed_description = kwargs.get("description")


class WebhookLogHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        return None


def attach_error_webhook_handler(logger_name: str = "publoader") -> None:
    """No-op: error notification is the core's job, from the result envelope."""


webhook_urls: List[str] = []
webhook_url: Union[str, None] = None
