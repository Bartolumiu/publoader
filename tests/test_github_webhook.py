"""Tests for the GitHub push-webhook listener.

The pure helpers (signature verification, push->slot mapping) are tested
directly; one end-to-end test drives a live listener on an ephemeral port to
confirm signature enforcement and that a valid push fires the on_push callback.
"""
import hashlib
import hmac
import json
import urllib.request
import urllib.error

import pytest

from publoader.github_webhook import (
    GithubWebhookListener,
    slot_for_push,
    verify_signature,
)

SECRET = "s3cr3t"
OWNER = "publoader"
SLOTS = {
    "publoader": "base",
    "publoader-extensions": "extensions",
    "publoader-extensions-private": "extensions-private",
}


def _sign(body: bytes, secret: str = SECRET) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def _push_payload(repo="publoader-extensions", ref=None, default="main", owner=OWNER):
    return {
        "ref": ref if ref is not None else f"refs/heads/{default}",
        "after": "abcdef1234567890",
        "repository": {
            "name": repo,
            "full_name": f"{owner}/{repo}",
            "default_branch": default,
        },
    }


# --- verify_signature -------------------------------------------------------


def test_verify_signature_accepts_correct_hmac():
    body = b'{"a": 1}'
    assert verify_signature(SECRET, body, _sign(body)) is True


def test_verify_signature_rejects_wrong_secret():
    body = b'{"a": 1}'
    assert verify_signature(SECRET, body, _sign(body, "other")) is False


def test_verify_signature_rejects_missing_header():
    assert verify_signature(SECRET, b"{}", "") is False


def test_verify_signature_rejects_empty_secret():
    body = b"{}"
    assert verify_signature("", body, _sign(body, "")) is False


# --- slot_for_push ----------------------------------------------------------


def test_slot_for_push_maps_tracked_repo():
    slot, reason = slot_for_push(_push_payload("publoader"), OWNER, SLOTS)
    assert slot == "base"
    assert reason is None


def test_slot_for_push_ignores_untracked_repo():
    slot, reason = slot_for_push(_push_payload("some-other-repo"), OWNER, SLOTS)
    assert slot is None
    assert "untracked" in reason


def test_slot_for_push_ignores_owner_mismatch():
    slot, reason = slot_for_push(_push_payload(owner="someone-else"), OWNER, SLOTS)
    assert slot is None
    assert "owner" in reason


def test_slot_for_push_ignores_non_default_branch():
    payload = _push_payload(ref="refs/heads/feature", default="main")
    slot, reason = slot_for_push(payload, OWNER, SLOTS)
    assert slot is None
    assert "ignored ref" in reason


# --- end-to-end through a live listener -------------------------------------


@pytest.fixture
def listener():
    received = []
    srv = GithubWebhookListener(
        host="127.0.0.1",
        port=0,  # ephemeral
        path="/webhook",
        secret=SECRET,
        owner=OWNER,
        repo_slots=SLOTS,
        on_push=lambda slot, payload: received.append((slot, payload)),
    )
    srv.start()
    srv.received = received
    srv.bound_port = srv._server.server_address[1]
    try:
        yield srv
    finally:
        srv.stop()


def _post(port, body: bytes, *, event="push", signature=None, path="/webhook"):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-GitHub-Event": event,
            **({"X-Hub-Signature-256": signature} if signature is not None else {}),
        },
    )
    try:
        resp = urllib.request.urlopen(req, timeout=5)
        return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_valid_push_fires_callback(listener):
    body = json.dumps(_push_payload("publoader-extensions")).encode()
    status, payload = _post(listener.bound_port, body, signature=_sign(body))
    assert status == 200
    assert payload == {"ok": True, "queued": "extensions"}
    assert listener.received[0][0] == "extensions"


def test_invalid_signature_rejected_and_no_callback(listener):
    body = json.dumps(_push_payload()).encode()
    status, payload = _post(listener.bound_port, body, signature=_sign(body, "wrong"))
    assert status == 401
    assert payload["ok"] is False
    assert listener.received == []


def test_missing_signature_rejected(listener):
    body = json.dumps(_push_payload()).encode()
    status, payload = _post(listener.bound_port, body)
    assert status == 401
    assert listener.received == []


def test_ping_event_acknowledged_without_callback(listener):
    body = b"{}"
    status, payload = _post(listener.bound_port, body, event="ping", signature=_sign(body))
    assert status == 200
    assert payload.get("pong") is True
    assert listener.received == []


def test_untracked_repo_ignored(listener):
    body = json.dumps(_push_payload("totally-unrelated")).encode()
    status, payload = _post(listener.bound_port, body, signature=_sign(body))
    assert status == 202
    assert payload["ok"] is True
    assert listener.received == []


def test_wrong_path_404(listener):
    body = b"{}"
    status, _ = _post(
        listener.bound_port, body, signature=_sign(body), path="/nope"
    )
    assert status == 404


def _get(port, *, path="/webhook"):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method="GET")
    try:
        resp = urllib.request.urlopen(req, timeout=5)
        return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_get_on_path_returns_health(listener):
    status, payload = _get(listener.bound_port)
    assert status == 200
    assert payload == {"ok": True, "listener": "alive"}
    assert listener.received == []


def test_get_on_wrong_path_404(listener):
    status, _ = _get(listener.bound_port, path="/nope")
    assert status == 404
