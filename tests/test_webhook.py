from publoader.webhook import (
    EMBED_MAX_FIELDS,
    EMBED_TOTAL_LIMIT,
    EMBEDS_PER_MESSAGE,
    PubloaderQueueWebhook,
    WebhookHelper,
    _parse_webhook_urls,
)


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


def _helper():
    return WebhookHelper(extension_name="demo")


def _embed_dict(title="Title", description="Desc", fields=None):
    return {
        "title": title,
        "description": description,
        "footer": {"text": "extensions.demo"},
        "color": "B86F8C",
        "fields": fields or [],
    }


def _field(name_len=100, value_len=900, tag=""):
    return {"name": ("n" * name_len) + tag, "value": "v" * value_len, "inline": True}


def test_split_embed_within_limits_is_untouched():
    helper = _helper()
    embed = _embed_dict(fields=[_field(), _field()])

    split = helper._split_embed(embed)

    assert len(split) == 1
    assert len(split[0]["fields"]) == 2
    assert split[0]["title"] == "Title"


def test_split_embed_over_total_limit_splits_by_size():
    helper = _helper()
    # 10 fields of ~1000 chars each -> ~10k chars, needs at least 2 embeds.
    embed = _embed_dict(fields=[_field(tag=str(i)) for i in range(10)])

    split = helper._split_embed(embed)

    assert len(split) > 1
    for part in split:
        assert helper._calculate_embed_size(part) <= EMBED_TOTAL_LIMIT
        assert len(part["fields"]) <= EMBED_MAX_FIELDS
        # Context (title/description/footer) is repeated on each part.
        assert part["title"] == "Title"
        assert part["footer"]["text"] == "extensions.demo"
    # No field is lost or duplicated by the split.
    all_names = [f["name"] for part in split for f in part["fields"]]
    assert all_names == [f["name"] for f in embed["fields"]]


def test_split_embed_caps_field_count_at_25():
    helper = _helper()
    embed = _embed_dict(fields=[_field(name_len=5, value_len=5, tag=str(i)) for i in range(60)])

    split = helper._split_embed(embed)

    assert [len(part["fields"]) for part in split] == [25, 25, 10]


def test_split_embed_truncates_oversized_components():
    helper = _helper()
    embed = _embed_dict(
        title="t" * 500,
        description="d" * 10000,
        fields=[{"name": "n" * 500, "value": "v" * 5000, "inline": True}],
    )

    split = helper._split_embed(embed)

    for part in split:
        assert len(part["title"]) <= 256
        assert len(part["description"]) <= 4096
        for field in part["fields"]:
            assert len(field["name"]) <= 256
            assert len(field["value"]) <= 1024
        assert helper._calculate_embed_size(part) <= EMBED_TOTAL_LIMIT


def test_split_embed_does_not_mutate_original_or_shared_footer():
    helper = _helper()
    shared_footer = {"text": "f" * 3000}
    embed = _embed_dict(description="d" * 10000)
    embed["footer"] = shared_footer

    helper._split_embed(embed)

    assert len(shared_footer["text"]) == 3000
    assert len(embed["description"]) == 10000


def test_split_embed_huge_base_with_fields_still_fits():
    helper = _helper()
    # title+description+footer alone would leave no room for any field.
    embed = _embed_dict(
        title="t" * 256,
        description="d" * 4096,
        fields=[_field(name_len=256, value_len=1024, tag="")],
    )
    embed["footer"] = {"text": "f" * 2048}

    split = helper._split_embed(embed)

    for part in split:
        assert helper._calculate_embed_size(part) <= EMBED_TOTAL_LIMIT
    assert sum(len(part["fields"]) for part in split) == 1


def test_batch_embeds_respects_message_total_limit():
    helper = _helper()
    # Each embed ~2000 chars: only 2 fit under 6000 per message even though
    # 10 would be allowed by count.
    embeds = [_embed_dict(description="d" * 2000, title=str(i)) for i in range(7)]

    batches = helper._batch_embeds(embeds)

    assert len(batches) == 4
    for batch in batches:
        assert len(batch) <= EMBEDS_PER_MESSAGE
        assert (
            sum(helper._calculate_embed_size(e) for e in batch) <= EMBED_TOTAL_LIMIT
        )
    # Nothing dropped, order preserved.
    assert [e["title"] for batch in batches for e in batch] == [
        str(i) for i in range(7)
    ]


def test_batch_embeds_respects_count_limit():
    helper = _helper()
    embeds = [_embed_dict(description="d", title=str(i)) for i in range(23)]

    batches = helper._batch_embeds(embeds)

    assert [len(b) for b in batches] == [10, 10, 3]


def test_check_embeds_size_splits_in_place_as_dicts():
    helper = _helper()
    from publoader.webhook import make_webhook

    wh = make_webhook()
    wh.add_embed(_embed_dict(fields=[_field(tag=str(i)) for i in range(10)]))
    wh.add_embed(_embed_dict(title="small"))

    helper.check_embeds_size(wh)

    assert len(wh.embeds) > 2
    for embed in wh.embeds:
        assert isinstance(embed, dict)
        assert helper._calculate_embed_size(embed) <= EMBED_TOTAL_LIMIT
