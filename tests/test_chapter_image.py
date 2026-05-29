"""Smoke tests for the chapter-card generator. The visual output isn't
asserted — only that we return real PNG bytes at the design's 2000x2000 size
and don't crash on the awkward shapes (missing fields, long titles, unicode)."""
import datetime
import io

import pytest

pytest.importorskip("PIL")

from PIL import Image

from publoader.chapter_image import generate_chapter_card


def _looks_like_png(data: bytes) -> bool:
    return data[:8] == b"\x89PNG\r\n\x1a\n"


def test_generates_full_card():
    data = generate_chapter_card(
        manga_name="Test Manga",
        chapter_number="42",
        chapter_title="The Reckoning",
        chapter_language="en",
        extension_name="mangaplus",
        publisher="Test Publisher",
        chapter_url="https://example.com/series/123/chapter/456",
        available_from=datetime.datetime(2025, 1, 1, tzinfo=datetime.timezone.utc),
        available_to=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
    )
    assert isinstance(data, bytes)
    assert len(data) > 1000  # sanity — a real PNG is at least a few KB
    assert _looks_like_png(data)


def test_card_is_square_2000():
    """The design exports at 2000x2000; the renderer should match."""
    img = Image.open(io.BytesIO(generate_chapter_card(manga_name="X")))
    assert img.size == (2000, 2000)


def test_sentinel_dates_are_dropped():
    """The 1990 'unknown' sentinel must not surface as an availability date."""
    sentinel = datetime.datetime(1990, 1, 1, tzinfo=datetime.timezone.utc)
    data = generate_chapter_card(
        manga_name="Test Manga",
        chapter_number="1",
        chapter_language="en",
        available_from=sentinel,
        available_to=sentinel,
    )
    assert _looks_like_png(data)


def test_handles_all_missing_fields():
    data = generate_chapter_card()
    assert _looks_like_png(data)


def test_long_title_doesnt_crash():
    data = generate_chapter_card(
        manga_name="A really, really, really, really, really long manga name that "
        "would otherwise blow past the card width",
        chapter_number="9999.5",
        chapter_title="Chapter title that goes on and on and on and on and on",
        chapter_language="en",
        extension_name="mangaplus",
        chapter_url="https://example.com/" + "x" * 200,
    )
    assert _looks_like_png(data)


def test_unicode_is_safe():
    data = generate_chapter_card(
        manga_name="進撃の巨人",
        chapter_number="139",
        chapter_title="この日々の意味",
        chapter_language="ja",
        extension_name="mangaplus",
    )
    assert _looks_like_png(data)
