"""Tests for the Discord-authenticated web dashboard.

These cover the security-critical pieces without standing up a real socket or
hitting Discord: signed-token round-trips (sessions + OAuth state), the user-id
allowlist parser, the command allowlist, and the request handler's auth gating
(via a lightweight fake handler that exercises the real methods)."""
import time
from unittest.mock import MagicMock, patch

import pytest

from publoader.dashboard import server as dash


SECRET = b"unit-test-secret"


# --- signed tokens -------------------------------------------------------------
def test_token_round_trip_and_claims():
    tok = dash.make_token(SECRET, {"uid": "42", "name": "ada", "exp": time.time() + 60})
    claims = dash.read_token(SECRET, tok, time.time())
    assert claims["uid"] == "42"
    assert claims["name"] == "ada"


def test_token_rejected_when_expired():
    tok = dash.make_token(SECRET, {"uid": "42", "exp": time.time() - 1})
    assert dash.read_token(SECRET, tok, time.time()) == {}


def test_token_rejected_when_tampered():
    tok = dash.make_token(SECRET, {"uid": "42", "exp": time.time() + 60})
    payload, sig = tok.split(".", 1)
    forged = dash.make_token(SECRET, {"uid": "999", "exp": time.time() + 60}).split(".", 1)[0]
    assert dash.read_token(SECRET, f"{forged}.{sig}", time.time()) == {}


def test_token_rejected_with_wrong_secret():
    tok = dash.make_token(SECRET, {"uid": "42", "exp": time.time() + 60})
    assert dash.read_token(b"other-secret", tok, time.time()) == {}


# --- allowlist parsing ---------------------------------------------------------
@pytest.mark.parametrize(
    "raw,expected",
    [
        ("", set()),
        ("123", {"123"}),
        ("123,456 789", {"123", "456", "789"}),
        ("123, 456,\n789", {"123", "456", "789"}),
    ],
)
def test_parse_user_ids(raw, expected):
    assert dash.parse_user_ids(raw) == expected


# --- command registry ----------------------------------------------------------
def test_read_and_write_command_classification():
    assert dash.COMMANDS["status"] is False  # GET-able read
    assert dash.COMMANDS["run"] is True       # POST-only write
    assert "evil_cmd" not in dash.COMMANDS


# --- auth gating on the real handler methods -----------------------------------
class _FakeSettings:
    def __init__(self, allowed):
        self.session_secret = SECRET
        self.allowed_users = set(allowed)
        self.active = True
        self.session_ttl = 3600


def _make_handler(settings, cookie="", body=b"", origin=None, host="dash.example"):
    """Build a _Handler without running BaseHTTPRequestHandler.__init__ (which
    would try to read a socket), wiring just what the methods under test use."""
    h = dash._Handler.__new__(dash._Handler)
    h.command = "GET"
    headers = {"Host": host}
    if cookie:
        headers["Cookie"] = cookie
    if origin is not None:
        headers["Origin"] = origin
    h.headers = headers
    h.path = "/api/cmd/status"
    h.server = MagicMock()
    h.server.settings = settings
    h._replies = []
    h._json = lambda code, payload, extra=None: h._replies.append((code, payload))
    return h


def _session_cookie(uid):
    tok = dash.make_token(SECRET, {"uid": uid, "name": "u", "exp": time.time() + 60})
    return f"{dash.SESSION_COOKIE}={tok}"


def test_api_cmd_rejects_anonymous():
    settings = _FakeSettings(allowed={"7"})
    h = _make_handler(settings)
    h._api_cmd("status", write=False)
    assert h._replies[0][0] == 401


def test_api_cmd_rejects_non_allowlisted_user():
    settings = _FakeSettings(allowed={"7"})
    h = _make_handler(settings, cookie=_session_cookie("999"))
    h._api_cmd("status", write=False)
    assert h._replies[0][0] == 401


def test_api_cmd_rejects_unknown_command():
    settings = _FakeSettings(allowed={"7"})
    h = _make_handler(settings, cookie=_session_cookie("7"))
    h._api_cmd("nuke_everything", write=False)
    assert h._replies[0][0] == 404


def test_api_cmd_write_command_requires_post():
    settings = _FakeSettings(allowed={"7"})
    h = _make_handler(settings, cookie=_session_cookie("7"))
    h._api_cmd("restart", write=False)  # GET on a write command
    assert h._replies[0][0] == 405


def test_api_cmd_proxies_to_ipc_when_authorised():
    settings = _FakeSettings(allowed={"7"})
    h = _make_handler(settings, cookie=_session_cookie("7"))
    h.path = "/api/cmd/status"
    with patch.object(dash, "ipc_call", return_value={"ok": True, "pid": 1}) as ipc:
        h._api_cmd("status", write=False)
    ipc.assert_called_once_with("status")
    assert h._replies[0] == (200, {"ok": True, "pid": 1})


def test_run_is_attributed_to_dashboard_user():
    settings = _FakeSettings(allowed={"7"})
    h = _make_handler(settings, cookie=_session_cookie("7"), origin="https://dash.example")
    h.path = "/api/cmd/run"
    h.headers["Content-Length"] = "2"
    h.rfile = MagicMock()
    h.rfile.read.return_value = b"{}"
    with patch.object(dash, "ipc_call", return_value={"ok": True}) as ipc:
        h._api_cmd("run", write=True)
    assert ipc.call_args.kwargs["triggered_by"].startswith("dashboard:")


def test_write_rejected_cross_origin():
    settings = _FakeSettings(allowed={"7"})
    h = _make_handler(settings, cookie=_session_cookie("7"), origin="https://evil.example")
    h.path = "/api/cmd/restart"
    h._api_cmd("restart", write=True)
    assert h._replies[0][0] == 403
