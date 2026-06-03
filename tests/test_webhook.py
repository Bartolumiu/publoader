from publoader.webhook import PubloaderQueueWebhook, _parse_webhook_urls


def test_parse_empty():
    assert _parse_webhook_urls("") == []
    assert _parse_webhook_urls(None) == []


def test_parse_single():
    assert _parse_webhook_urls("https://discord.com/api/webhooks/1/abc") == [
        "https://discord.com/api/webhooks/1/abc"
    ]


def test_parse_comma_separated():
    urls = _parse_webhook_urls(
        "https://discord.com/api/webhooks/1/abc, https://discord.com/api/webhooks/2/def"
    )
    assert urls == [
        "https://discord.com/api/webhooks/1/abc",
        "https://discord.com/api/webhooks/2/def",
    ]


def test_parse_newline_separated():
    urls = _parse_webhook_urls(
        "https://discord.com/api/webhooks/1/abc\nhttps://discord.com/api/webhooks/2/def"
    )
    assert urls == [
        "https://discord.com/api/webhooks/1/abc",
        "https://discord.com/api/webhooks/2/def",
    ]


def test_parse_mixed_with_blanks():
    urls = _parse_webhook_urls("a\n\n,b , \nc\n   ")
    assert urls == ["a", "b", "c"]


def _chapter():
    return {"manga_name": "Demo", "chapter_number": "1", "extension_name": "demo"}


def test_unavailable_worker_tallies_instead_of_per_chapter_embeds():
    wh = PubloaderQueueWebhook(worker_type="unavailable", colour="9B9B9B")

    for _ in range(8):
        wh.add_chapter(_chapter(), processed=True)
    wh.add_chapter(_chapter(), processed=False)

    # No per-chapter embed fields are built; everything is just counted.
    assert wh.fields == []
    assert wh.processed_count == 8
    assert wh.failed_count == 1


def test_unavailable_send_summary_resets_counts():
    wh = PubloaderQueueWebhook(worker_type="unavailable", colour="9B9B9B")
    wh.add_chapter(_chapter(), processed=True)
    wh.add_chapter(_chapter(), processed=True)

    wh.send_summary()

    assert wh.processed_count == 0
    assert wh.failed_count == 0


def test_send_summary_noop_for_non_summary_worker():
    wh = PubloaderQueueWebhook(worker_type="editor", colour="FFF71C")
    wh.add_chapter(_chapter(), processed=True)

    # Editor still uses per-chapter fields and ignores the count path entirely.
    assert wh.processed_count == 0
    assert len(wh.fields) == 1
    wh.send_summary()  # must not raise / must not clear editor fields
    assert len(wh.fields) == 1
