"""A tiny HTTP listener for GitHub push webhooks.

GitHub posts to this endpoint the instant code is pushed to a tracked repo,
letting the bot download the update immediately rather than waiting for the
scheduled daily restart. Built on the stdlib http.server so it adds no
dependency; it only ever needs to handle a single, well-known POST shape.

Security: every delivery's X-Hub-Signature-256 HMAC is verified against the
configured shared secret before any action is taken. Without a valid signature
the request is rejected, so the update trigger can't be fired by an attacker.
"""
import hashlib
import hmac
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logger = logging.getLogger("publoader")

# GitHub push payloads are tens of KB at most; cap the body we'll buffer so a
# rogue client can't make us read unbounded data.
_MAX_BODY_BYTES = 5 * 1024 * 1024


def verify_signature(secret: str, body: bytes, signature_header: str) -> bool:
    """Constant-time check of GitHub's X-Hub-Signature-256 header."""
    if not secret or not signature_header:
        return False
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header)


def slot_for_push(payload: dict, owner: str, repo_slots: dict):
    """Map a push payload to an internal repo slot, or (None, reason) when the
    push should be ignored (untracked repo, wrong owner, or a non-default
    branch). `repo_slots` maps GitHub repo name -> 'base'/'extensions'/... ."""
    repo = payload.get("repository") or {}
    name = repo.get("name")
    slot = repo_slots.get(name)
    if slot is None:
        return None, f"untracked repo {name!r}"

    full_name = (repo.get("full_name") or "").lower()
    if owner and full_name and full_name != f"{owner}/{name}".lower():
        return None, "owner mismatch"

    default_branch = repo.get("default_branch")
    ref = payload.get("ref")
    if default_branch and ref and ref != f"refs/heads/{default_branch}":
        return None, f"ignored ref {ref}"

    return slot, None


class _WebhookHandler(BaseHTTPRequestHandler):
    # Config is attached to the server instance by GithubWebhookListener.
    def log_message(self, fmt, *args):  # route stdlib logging through ours
        logger.debug("github-webhook %s", fmt % args)

    def _reply(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802 (stdlib naming)
        cfg = self.server.publoader_cfg

        if self.path.split("?", 1)[0] != cfg["path"]:
            self._reply(404, {"ok": False, "error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > _MAX_BODY_BYTES:
            self._reply(400, {"ok": False, "error": "bad content length"})
            return

        body = self.rfile.read(length)
        if not verify_signature(
            cfg["secret"], body, self.headers.get("X-Hub-Signature-256", "")
        ):
            self._reply(401, {"ok": False, "error": "invalid signature"})
            return

        event = self.headers.get("X-GitHub-Event", "")
        if event == "ping":
            self._reply(200, {"ok": True, "pong": True})
            return
        if event != "push":
            self._reply(202, {"ok": True, "ignored": f"event {event!r}"})
            return

        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self._reply(400, {"ok": False, "error": "invalid json"})
            return

        slot, reason = slot_for_push(payload, cfg["owner"], cfg["repo_slots"])
        if slot is None:
            self._reply(202, {"ok": True, "ignored": reason})
            return

        try:
            cfg["on_push"](slot, payload)
        except Exception:
            logger.exception("github webhook on_push handler failed")
            self._reply(500, {"ok": False, "error": "handler error"})
            return

        self._reply(200, {"ok": True, "queued": slot})


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class GithubWebhookListener:
    """Owns the background HTTP server thread. `on_push(slot, payload)` is
    invoked (off the main thread) for each verified push to a tracked repo."""

    def __init__(self, *, host, port, path, secret, owner, repo_slots, on_push):
        self.host = host
        self.port = port
        self.path = path
        self._server = _Server((host, port), _WebhookHandler)
        self._server.publoader_cfg = {
            "path": path,
            "secret": secret,
            "owner": owner,
            "repo_slots": dict(repo_slots),
            "on_push": on_push,
        }
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="github-webhook",
            daemon=True,
        )

    def start(self):
        self._thread.start()
        logger.info(
            f"GitHub webhook listener started on "
            f"http://{self.host}:{self.port}{self.path}"
        )

    def stop(self):
        try:
            self._server.shutdown()
        finally:
            self._server.server_close()
