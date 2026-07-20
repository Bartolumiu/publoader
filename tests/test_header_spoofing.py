"""Tests for extension header spoofing (publoader/http/rotation.py).

Covers the browser-profile header set, the global ``requests.Session.request``
spoof hook (per-session identity, caller-header precedence, the MangaDex
opt-out, idempotency, disabled no-op), and the aiohttp ``ClientSession``
spoof hook. No real network traffic is sent — a stub adapter answers requests
locally.
"""
import asyncio

import pytest
import requests
from requests.adapters import HTTPAdapter
from requests.models import Response

from requests import sessions as _sessions

from publoader.http.rotation import (
    install_global_aiohttp_header_spoofing,
    install_global_header_spoofing,
    random_browser_headers,
)


class _StubAdapter(HTTPAdapter):
    """Answers every request with a canned 200 and records the sent headers."""

    def __init__(self):
        super().__init__()
        self.last_headers = None

    def send(self, request, **kwargs):
        self.last_headers = request.headers
        resp = Response()
        resp.status_code = 200
        resp._content = b""
        resp.url = request.url
        resp.request = request
        return resp


@pytest.fixture
def restore_session_request():
    """Undo the global Session.request monkeypatch after a test."""
    original = _sessions.Session.request
    yield
    _sessions.Session.request = original


@pytest.fixture
def restore_aiohttp_init():
    """Undo the global aiohttp ClientSession.__init__ monkeypatch after a test."""
    aiohttp = pytest.importorskip("aiohttp")
    original = aiohttp.ClientSession.__init__
    yield aiohttp
    aiohttp.ClientSession.__init__ = original


def _stubbed_session():
    """A Session whose transport is a local stub (no network)."""
    session = requests.Session()
    adapter = _StubAdapter()
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session, adapter


# --- random_browser_headers -------------------------------------------------


def test_random_browser_headers_is_coherent():
    for _ in range(30):
        headers = random_browser_headers()
        ua = headers["User-Agent"]
        assert "python-requests" not in ua
        assert headers["Accept-Language"].startswith("en")
        assert headers["Accept-Encoding"]
        # Client hints only ship on Chromium engines, and then must agree with
        # the User-Agent's mobile-ness.
        if "Sec-CH-UA" in headers:
            assert "Chrome" in ua or "Edg" in ua
            mobile = headers["Sec-CH-UA-Mobile"]
            assert (mobile == "?1") == ("Mobile" in ua)
        else:
            # Firefox/Safari send neither the brand list nor the mobile hint.
            assert "Sec-CH-UA-Mobile" not in headers


# --- requests hook ----------------------------------------------------------


def test_spoof_pins_browser_headers_on_session(restore_session_request):
    assert install_global_header_spoofing(True) is True
    session, adapter = _stubbed_session()

    session.get("http://example.test/")

    sent = adapter.last_headers
    assert "python-requests" not in sent["User-Agent"]
    assert sent["Accept-Language"].startswith("en")


def test_spoof_identity_stable_across_requests(restore_session_request):
    install_global_header_spoofing(True)
    session, adapter = _stubbed_session()

    session.get("http://example.test/one")
    first = adapter.last_headers["User-Agent"]
    session.get("http://example.test/two")
    second = adapter.last_headers["User-Agent"]

    # A real user's browser keeps one identity for the whole session.
    assert first == second


def test_spoof_respects_caller_headers(restore_session_request):
    install_global_header_spoofing(True)
    session, adapter = _stubbed_session()
    session.headers["User-Agent"] = "my-extension/2.0"

    session.get("http://example.test/")

    # Header the extension set itself always wins over the spoof default.
    assert adapter.last_headers["User-Agent"] == "my-extension/2.0"
    # ...but unset headers are still filled in.
    assert adapter.last_headers["Accept-Language"].startswith("en")


def test_mangadex_session_is_not_spoofed(restore_session_request):
    install_global_header_spoofing(True)
    session, adapter = _stubbed_session()
    session.headers["User-Agent"] = "publoader/9.9.9"
    session._publoader_no_spoof = True

    session.get("http://example.test/")

    assert adapter.last_headers["User-Agent"] == "publoader/9.9.9"
    # None of the browser navigation headers were added.
    assert "Sec-Fetch-Mode" not in adapter.last_headers


def test_spoof_disabled_is_noop(restore_session_request):
    before = _sessions.Session.request
    assert install_global_header_spoofing(False) is False
    assert _sessions.Session.request is before


def test_spoof_idempotent(restore_session_request):
    install_global_header_spoofing(True)
    patched = _sessions.Session.request
    assert install_global_header_spoofing(True) is True
    assert _sessions.Session.request is patched


# --- aiohttp hook -----------------------------------------------------------


def test_aiohttp_spoof_injects_default_headers(restore_aiohttp_init):
    aiohttp = restore_aiohttp_init
    install_global_aiohttp_header_spoofing(True)

    async def check():
        session = aiohttp.ClientSession()
        headers = dict(session._default_headers)
        await session.close()
        return headers

    headers = asyncio.run(check())
    assert "python-requests" not in headers.get("User-Agent", "")
    assert headers.get("User-Agent")
    assert headers.get("Accept-Language", "").startswith("en")


def test_aiohttp_spoof_caller_headers_win(restore_aiohttp_init):
    aiohttp = restore_aiohttp_init
    install_global_aiohttp_header_spoofing(True)

    async def check():
        session = aiohttp.ClientSession(headers={"User-Agent": "ext/1.0"})
        headers = dict(session._default_headers)
        await session.close()
        return headers

    headers = asyncio.run(check())
    assert headers["User-Agent"] == "ext/1.0"
    # Spoof still supplies the headers the caller didn't set.
    assert headers.get("Accept-Language", "").startswith("en")


def test_aiohttp_spoof_disabled_is_noop(restore_aiohttp_init):
    aiohttp = restore_aiohttp_init
    before = aiohttp.ClientSession.__init__
    assert install_global_aiohttp_header_spoofing(False) is False
    assert aiohttp.ClientSession.__init__ is before


def test_aiohttp_spoof_idempotent(restore_aiohttp_init):
    aiohttp = restore_aiohttp_init
    install_global_aiohttp_header_spoofing(True)
    patched = aiohttp.ClientSession.__init__
    assert install_global_aiohttp_header_spoofing(True) is True
    assert aiohttp.ClientSession.__init__ is patched
