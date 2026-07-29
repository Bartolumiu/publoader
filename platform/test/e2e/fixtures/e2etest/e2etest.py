"""Deterministic e2e fixture extension.

Exercises the real extension contract end-to-end without touching any external
site: two chapters for the one tracked manga, plus one untracked manga so the
automated title pipeline has something to persist. Also doubles as the
failover fixture: if the platform-delivered manga id map contains the marker
external id "slow", the run sleeps long enough for the driver to kill the
executing worker and watch the lease fail over.
"""
import time
from datetime import timedelta
from pathlib import Path


class Extension:
    def __init__(self, extension_dirpath):
        self.extension_dirpath = Path(extension_dirpath)
        self.name = "e2etest"
        self.disabled = False
        self.mangadex_group_id = "22222222-2222-4222-8222-222222222222"
        self.extension_languages = ["en"]
        self.override_options = {}
        self.tracked_mangadex_ids = []
        self._posted_ids = []
        self._id_map = {}

    def update_external_data(self, posted_chapter_ids, clean_db):
        from publoader.utils.utils import open_manga_id_map

        self._posted_ids = [str(x) for x in (posted_chapter_ids or [])]
        self._id_map = open_manga_id_map(
            self.extension_dirpath.joinpath("manga_id_map.json")
        )
        self.tracked_mangadex_ids = list(self._id_map.keys())

    def get_updated_chapters(self):
        from publoader.models.dataclasses import Chapter
        from publoader.utils.utils import get_current_datetime

        externals = {e for ids in self._id_map.values() for e in ids}
        if "slow" in externals:
            # Failover mode: outlive several lease-renewal intervals so a
            # `docker kill` of this worker is observable as a lease expiry.
            time.sleep(90)

        now = get_current_datetime()
        md_manga_id = next(iter(self._id_map.keys()), None)
        chapters = []
        for number in ("1", "2"):
            chapter_id = f"c{number}"
            if chapter_id in self._posted_ids:
                continue
            chapters.append(
                Chapter(
                    chapter_timestamp=now,
                    chapter_expire=now + timedelta(days=7),
                    chapter_language="en",
                    chapter_number=number,
                    chapter_title=f"E2E Chapter {number}",
                    chapter_id=chapter_id,
                    chapter_url=f"https://e2e.example.com/chapter/{chapter_id}",
                    manga_id="m1",
                    md_manga_id=md_manga_id,
                    manga_name="E2E Test Manga",
                    manga_url="https://e2e.example.com/manga/m1",
                )
            )
        return chapters

    def get_all_chapters(self):
        return []

    def get_updated_manga(self):
        from publoader.models.dataclasses import Manga

        return [
            Manga(
                manga_id="m2",
                manga_name="Untracked E2E Manga",
                manga_language="en",
                manga_url="https://e2e.example.com/manga/m2",
            )
        ]
