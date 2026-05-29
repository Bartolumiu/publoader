"""Tests for the unavailable worker (workers/unavailable.py).

The worker now generates the chapter card and attaches it to the live chapter
via an edit upload session, then clears externalUrl with a full PUT /chapter
edit (the ChapterEdit schema requires the whole body + version). These tests
drive UnavailableProcess.mark_unavailable() with a fake http_client so we can
assert the begin/upload/commit/edit sequence and payloads without hitting MD.
"""
import pytest

pytest.importorskip("PIL")

from publoader.utils.config import mangadex_api_url, md_upload_api_url
from publoader.workers.unavailable import UnavailableProcess


class FakeResp:
    def __init__(self, status_code=200, data=None):
        self.status_code = status_code
        self.data = data

    @property
    def ok(self):
        return 200 <= self.status_code < 300


def _chapter_doc(external_url="https://publisher.example/ch/1", version=3):
    return {
        "id": "md-chap-1",
        "attributes": {
            "volume": "2",
            "chapter": "5",
            "title": "A Title",
            "translatedLanguage": "en",
            "externalUrl": external_url,
            "version": version,
        },
        "relationships": [{"type": "scanlation_group", "id": "group-1"}],
    }


class FakeHTTP:
    """Routes calls by URL and records them. GET /chapter/{id} pops a queue so
    the worker's fetch-then-probe pattern can return different responses."""

    def __init__(
        self, *, chapter_responses, begin=None, upload=None, commit=None, edit=None
    ):
        self.chapter_responses = list(chapter_responses)
        self.begin = begin or FakeResp(200, {"data": {"id": "session-1"}})
        self.upload = upload or FakeResp(
            200, {"result": "ok", "errors": [], "data": [{"id": "page-1"}]}
        )
        # Commit bumps the version; the worker reuses it for the PUT edit.
        self.commit = commit or FakeResp(
            200, {"data": {"id": "md-chap-1", "attributes": {"version": 4}}}
        )
        self.edit = edit or FakeResp(200, {"data": {"id": "md-chap-1"}})
        self.calls = []

    def get(self, route, params=None, successful_codes=None, **kwargs):
        self.calls.append(("GET", route, {"params": params}))
        if route == md_upload_api_url:  # existing-session probe
            return FakeResp(404, None)
        if "/chapter/" in route:
            return self.chapter_responses.pop(0)
        raise AssertionError(f"unexpected GET {route}")

    def post(
        self, route, json=None, data=None, files=None, successful_codes=None, **kw
    ):
        self.calls.append(("POST", route, {"json": json, "files": files}))
        if route.startswith(f"{md_upload_api_url}/begin/"):
            return self.begin
        if route.endswith("/commit"):
            return self.commit
        return self.upload  # POST /upload/{session}

    def put(self, route, json=None, data=None, files=None, successful_codes=None, **kw):
        self.calls.append(("PUT", route, {"json": json}))
        return self.edit

    def delete(self, route, successful_codes=None, **kwargs):
        self.calls.append(("DELETE", route, {}))
        return FakeResp(200, None)

    def find(self, method, url_contains):
        return [c for c in self.calls if c[0] == method and url_contains in c[1]]


def _item():
    return {
        "_id": "row-1",
        "md_chapter_id": "md-chap-1",
        "extension_name": "demo",
        "manga_name": "Demo Manga",
        "chapter_number": "5",
        "chapter_title": "A Title",
        "chapter_language": "en",
        "chapter_url": "https://publisher.example/ch/1",
    }


def test_uploads_card_then_clears_external_url():
    http = FakeHTTP(chapter_responses=[FakeResp(200, {"data": _chapter_doc()})])
    proc = UnavailableProcess(_item(), http)

    assert proc.mark_unavailable() is True

    # Edit session was opened on the chapter with its current version.
    begin = http.find("POST", "/upload/begin/md-chap-1")
    assert begin and begin[0][2]["json"] == {"version": 3}

    # The card was uploaded to the session.
    assert http.find("POST", f"{md_upload_api_url}/session-1")

    # Commit attaches the page but keeps externalUrl (chapterDraft can't null it).
    commit = http.find("POST", "/session-1/commit")[0][2]["json"]
    assert commit["chapterDraft"]["externalUrl"] == "https://publisher.example/ch/1"
    assert commit["chapterDraft"]["chapter"] == "5"
    assert "version" not in commit["chapterDraft"]
    assert "groups" not in commit["chapterDraft"]
    assert commit["pageOrder"] == ["page-1"]

    # The PUT edit sends the full body, nulls externalUrl, uses the bumped version.
    edit = http.find("PUT", f"{mangadex_api_url}/chapter/md-chap-1")[0][2]["json"]
    assert edit["externalUrl"] is None
    assert edit["version"] == 4
    assert edit["groups"] == ["group-1"]
    assert edit["volume"] == "2"
    assert edit["chapter"] == "5"
    assert edit["title"] == "A Title"
    assert edit["translatedLanguage"] == "en"


def test_already_cleared_is_success_without_uploading():
    http = FakeHTTP(
        chapter_responses=[FakeResp(200, {"data": _chapter_doc(external_url=None)})]
    )
    proc = UnavailableProcess(_item(), http)

    assert proc.mark_unavailable() is True
    assert not http.find("POST", "/upload/begin/")
    assert not http.find("PUT", "/chapter/")


def test_missing_chapter_404_archives():
    # First fetch (with includes) 404s, follow-up probe also 404s → archive.
    http = FakeHTTP(chapter_responses=[FakeResp(404, None), FakeResp(404, None)])
    proc = UnavailableProcess(_item(), http)

    assert proc.mark_unavailable() is True
    assert not http.find("POST", "/upload/begin/")


def test_commit_failure_keeps_on_queue_and_aborts_session():
    http = FakeHTTP(
        chapter_responses=[FakeResp(200, {"data": _chapter_doc()})],
        commit=FakeResp(500, {"errors": [{"detail": "boom"}]}),
    )
    proc = UnavailableProcess(_item(), http)

    assert proc.mark_unavailable() is False
    # Failed commit should abandon the upload session and not attempt the edit.
    assert http.find("DELETE", f"{md_upload_api_url}/session-1")
    assert not http.find("PUT", "/chapter/")


def test_edit_failure_keeps_on_queue():
    http = FakeHTTP(
        chapter_responses=[FakeResp(200, {"data": _chapter_doc()})],
        edit=FakeResp(400, {"errors": [{"detail": "bad"}]}),
    )
    proc = UnavailableProcess(_item(), http)

    assert proc.mark_unavailable() is False
    # Commit happened, but the externalUrl edit failed.
    assert http.find("POST", "/session-1/commit")
    assert http.find("PUT", f"{mangadex_api_url}/chapter/md-chap-1")


def test_commit_without_version_refetches_for_edit():
    # Commit response omits attributes.version → worker re-fetches the chapter.
    http = FakeHTTP(
        chapter_responses=[
            FakeResp(200, {"data": _chapter_doc(version=3)}),
            FakeResp(200, {"data": _chapter_doc(version=7)}),  # re-fetch
        ],
        commit=FakeResp(200, {"data": {"id": "md-chap-1"}}),
    )
    proc = UnavailableProcess(_item(), http)

    assert proc.mark_unavailable() is True
    edit = http.find("PUT", f"{mangadex_api_url}/chapter/md-chap-1")[0][2]["json"]
    assert edit["version"] == 7


def test_begin_failure_keeps_on_queue():
    http = FakeHTTP(
        chapter_responses=[FakeResp(200, {"data": _chapter_doc()})],
        begin=FakeResp(400, None),
    )
    proc = UnavailableProcess(_item(), http)

    assert proc.mark_unavailable() is False
    assert not http.find("POST", "/session-1/commit")
