"""Discord-authenticated web dashboard for publoader.

Serves a single-page control panel that views every piece of bot state and
drives every control command, by proxying the same IPC unix socket the Discord
bot uses (`publoader.ipc.ipc_call`). Access is gated behind Discord OAuth2 login
and restricted to an allowlist of Discord user IDs — defaulting to the bot's
existing [Paths]DISCORD_ADMIN_USERS so the same people who can run slash commands
can use the dashboard.

Built on the stdlib http.server (like the GitHub webhook listener) so it adds no
runtime dependency beyond `requests`, which is already required. It runs in its
own container (publoader-dash) fronted by the Cloudflare tunnel — see
docker-compose.yml and the README's dashboard section for ingress setup.

Security model:
  * Every /api/* route requires a valid signed session cookie whose Discord user
    id is in the allowlist. Sessions are HMAC-signed (SESSION_SECRET) and expire.
  * The OAuth round-trip carries a signed `state` cookie to defeat CSRF on login.
  * Session cookies are HttpOnly + Secure + SameSite=Lax; combined with an Origin
    check on writes, that blocks cross-site command execution.
  * Only an explicit allowlist of IPC commands is reachable, and only the read
    commands are callable via GET; everything that mutates requires POST.
"""
import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import requests

from publoader.ipc import ipc_call
from publoader.utils.config import config

logger = logging.getLogger("publoader")

# --- Discord OAuth2 endpoints --------------------------------------------------
DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize"
DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token"
DISCORD_USER_URL = "https://discord.com/api/users/@me"
OAUTH_SCOPE = "identify"

SESSION_COOKIE = "publoader_session"
STATE_COOKIE = "publoader_oauth_state"
STATE_TTL_SECONDS = 600  # 10 minutes to complete the login round-trip

_INDEX_HTML = Path(__file__).with_name("index.html")

# IPC command -> requires POST (i.e. mutates state). Anything not listed here is
# not reachable from the dashboard at all. Mirrors the handlers registered in
# run.py's _setup_ipc_server.
COMMANDS = {
    # read-only views (GET)
    "status": False,
    "stats": False,
    "list_schedule": False,
    "list_extensions": False,
    "run_history": False,
    "logs": False,
    "queue_peek": False,
    "mdauth_status": False,
    "config_show": False,
    "get_removal_mode": False,
    # state-changing controls (POST)
    "run": True,
    "reload": True,
    "restart": True,
    "pull": True,
    "set_schedule": True,
    "remove_schedule": True,
    "set_removal_mode": True,
    "enable_extension": True,
    "disable_extension": True,
    "queue_clear": True,
    "restart_workers": True,
    "config_set": True,
    "force_login": True,
    "logout": True,
    "pause": True,
    "resume": True,
}


# --- Configuration -------------------------------------------------------------
def _cfg(option: str, fallback: str = "") -> str:
    try:
        return config["Dashboard"].get(option, fallback) or fallback
    except KeyError:
        return fallback


def _paths(option: str, fallback: str = "") -> str:
    try:
        return config["Paths"].get(option, fallback) or fallback
    except KeyError:
        return fallback


def parse_user_ids(raw: str) -> set:
    """Split a comma/space/newline-separated list of Discord IDs into a set of
    strings (Discord IDs are 64-bit snowflakes — keep them as strings)."""
    if not raw:
        return set()
    return {tok for tok in raw.replace(",", " ").split() if tok.strip()}


class Settings:
    """Resolved dashboard configuration, with env-var fallbacks."""

    def __init__(self):
        self.enabled = _cfg("enabled", "false").lower() in ("1", "true", "yes", "on")
        self.host = _cfg("host", "0.0.0.0") or "0.0.0.0"
        try:
            self.port = int(_cfg("port", "8090") or "8090")
        except ValueError:
            self.port = 8090
        self.client_id = _cfg("discord_client_id") or os.environ.get(
            "PUBLOADER_DASH_CLIENT_ID", ""
        )
        self.client_secret = _cfg("discord_client_secret") or os.environ.get(
            "PUBLOADER_DASH_CLIENT_SECRET", ""
        )
        self.redirect_uri = _cfg("redirect_uri") or os.environ.get(
            "PUBLOADER_DASH_REDIRECT_URI", ""
        )
        # Allowlist: dedicated [Dashboard]allowed_users, else reuse the bot admins.
        allowed = _cfg("allowed_users") or _paths("discord_admin_users")
        self.allowed_users = parse_user_ids(allowed)
        try:
            self.session_ttl = int(_cfg("session_ttl_minutes", "720") or "720") * 60
        except ValueError:
            self.session_ttl = 720 * 60

        secret = _cfg("session_secret") or os.environ.get("PUBLOADER_DASH_SECRET", "")
        if not secret:
            secret = secrets.token_urlsafe(48)
            logger.warning(
                "[Dashboard]SESSION_SECRET is unset; using an ephemeral secret — "
                "all sessions will be invalidated on restart. Set one for production."
            )
        self.session_secret = secret.encode("utf-8")

        # `active` gates the app routes. Even when inactive the server still binds
        # and answers /healthz, so the container stays healthy (no autoheal churn)
        # and flips to a full dashboard the moment it's enabled + configured.
        self.active = self.enabled and not self.misconfigured()

    def misconfigured(self) -> str:
        """Return a human-readable reason the dashboard can't run, or ''."""
        if not self.client_id or not self.client_secret:
            return "DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET are unset"
        if not self.redirect_uri:
            return "REDIRECT_URI is unset"
        if not self.allowed_users:
            return (
                "no ALLOWED_USERS (and no [Paths]DISCORD_ADMIN_USERS) — refusing to "
                "start a dashboard nobody is allowed to log into"
            )
        return ""


# --- Signed-token helpers (sessions + oauth state) -----------------------------
def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(secret: bytes, payload_b64: str) -> str:
    return _b64e(hmac.new(secret, payload_b64.encode("ascii"), hashlib.sha256).digest())


def make_token(secret: bytes, claims: dict) -> str:
    """HMAC-signed, URL-safe `<payload>.<sig>` token carrying `claims`."""
    payload_b64 = _b64e(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
    return f"{payload_b64}.{_sign(secret, payload_b64)}"


def read_token(secret: bytes, token: str, now: float) -> dict:
    """Verify signature + `exp`, returning the claims dict or {} on any failure."""
    if not token or "." not in token:
        return {}
    payload_b64, sig = token.split(".", 1)
    if not hmac.compare_digest(sig, _sign(secret, payload_b64)):
        return {}
    try:
        claims = json.loads(_b64d(payload_b64))
    except (ValueError, json.JSONDecodeError):
        return {}
    if float(claims.get("exp", 0)) < now:
        return {}
    return claims


def build_authorize_url(settings: Settings, state: str) -> str:
    params = urlencode(
        {
            "client_id": settings.client_id,
            "redirect_uri": settings.redirect_uri,
            "response_type": "code",
            "scope": OAUTH_SCOPE,
            "state": state,
            "prompt": "consent",
        }
    )
    return f"{DISCORD_AUTHORIZE_URL}?{params}"


# --- HTTP handler --------------------------------------------------------------
class _Handler(BaseHTTPRequestHandler):
    server_version = "publoader-dashboard/1.0"

    @property
    def settings(self) -> Settings:
        return self.server.settings  # type: ignore[attr-defined]

    def log_message(self, fmt, *args):  # route stdlib logging through ours
        logger.debug("dashboard %s", fmt % args)

    # -- low-level reply helpers -------------------------------------------------
    def _send(self, code, body=b"", content_type="application/json", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (extra or []):
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, payload, extra=None):
        self._send(code, json.dumps(payload), "application/json", extra)

    def _redirect(self, location, extra=None):
        self._send(303, b"", "text/plain", [("Location", location), *(extra or [])])

    def _cookie_header(self, name, value, max_age):
        attrs = [
            f"{name}={value}",
            "Path=/",
            "HttpOnly",
            "Secure",
            "SameSite=Lax",
            f"Max-Age={max_age}",
        ]
        return ("Set-Cookie", "; ".join(attrs))

    def _read_cookie(self, name):
        raw = self.headers.get("Cookie")
        if not raw:
            return ""
        try:
            jar = SimpleCookie(raw)
        except Exception:
            return ""
        morsel = jar.get(name)
        return morsel.value if morsel else ""

    # -- auth --------------------------------------------------------------------
    def _session(self):
        """Return the logged-in user's claims, or {} if not authenticated."""
        claims = read_token(
            self.settings.session_secret, self._read_cookie(SESSION_COOKIE), time.time()
        )
        if claims and claims.get("uid") in self.settings.allowed_users:
            return claims
        return {}

    def _same_origin(self) -> bool:
        """For state-changing requests, require the Origin (when present) to match
        the Host we were reached on — a second guard beyond SameSite=Lax."""
        origin = self.headers.get("Origin")
        if not origin:
            return True  # non-browser / same-origin form posts omit Origin
        host = self.headers.get("Host", "")
        return urlparse(origin).netloc == host

    # -- routing -----------------------------------------------------------------
    def do_GET(self):  # noqa: N802
        path = urlparse(self.path).path
        if path == "/healthz":
            return self._json(200, {"ok": True, "service": "dashboard",
                                    "active": self.settings.active})
        if not self.settings.active:
            if path in ("/", "/index.html"):
                return self._send(
                    200, "<h1>publoader dashboard is disabled</h1>"
                         "<p>Set [Dashboard]ENABLED=true and configure Discord OAuth.</p>",
                    "text/html; charset=utf-8",
                )
            return self._json(503, {"ok": False, "error": "dashboard disabled"})
        if path in ("/", "/index.html"):
            return self._serve_index()
        if path == "/auth/login":
            return self._auth_login()
        if path == "/auth/callback":
            return self._auth_callback()
        if path == "/auth/logout":
            return self._auth_logout()
        if path == "/api/me":
            return self._api_me()
        if path.startswith("/api/cmd/"):
            return self._api_cmd(path[len("/api/cmd/"):], write=False)
        return self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):  # noqa: N802
        path = urlparse(self.path).path
        if not self.settings.active:
            return self._json(503, {"ok": False, "error": "dashboard disabled"})
        if path.startswith("/api/cmd/"):
            return self._api_cmd(path[len("/api/cmd/"):], write=True)
        return self._json(404, {"ok": False, "error": "not found"})

    do_HEAD = do_GET

    # -- handlers ----------------------------------------------------------------
    def _serve_index(self):
        try:
            html = _INDEX_HTML.read_bytes()
        except OSError:
            return self._send(500, b"dashboard UI missing", "text/plain")
        self._send(200, html, "text/html; charset=utf-8")

    def _api_me(self):
        session = self._session()
        if not session:
            return self._json(401, {"ok": False, "authenticated": False})
        return self._json(
            200,
            {"ok": True, "authenticated": True,
             "user": {"id": session.get("uid"), "name": session.get("name")}},
        )

    def _auth_login(self):
        state = secrets.token_urlsafe(24)
        state_token = make_token(
            self.settings.session_secret,
            {"st": state, "exp": time.time() + STATE_TTL_SECONDS},
        )
        location = build_authorize_url(self.settings, state)
        self._redirect(
            location, [self._cookie_header(STATE_COOKIE, state_token, STATE_TTL_SECONDS)]
        )

    def _auth_callback(self):
        params = parse_qs(urlparse(self.path).query)
        code = (params.get("code") or [""])[0]
        returned_state = (params.get("state") or [""])[0]

        state_claims = read_token(
            self.settings.session_secret, self._read_cookie(STATE_COOKIE), time.time()
        )
        if not code or not returned_state or state_claims.get("st") != returned_state:
            return self._send(400, "Login failed: invalid or expired state.", "text/plain")

        try:
            user = self._exchange_code(code)
        except Exception:
            logger.exception("dashboard OAuth code exchange failed")
            return self._send(502, "Login failed: Discord rejected the exchange.", "text/plain")

        uid = str(user.get("id", ""))
        if uid not in self.settings.allowed_users:
            logger.warning("dashboard login denied for non-allowlisted user %s", uid)
            return self._send(
                403,
                "Your Discord account is not authorised for this dashboard.",
                "text/plain",
            )

        name = user.get("global_name") or user.get("username") or uid
        session = make_token(
            self.settings.session_secret,
            {"uid": uid, "name": name, "exp": time.time() + self.settings.session_ttl},
        )
        logger.info("dashboard login: %s (%s)", name, uid)
        # Clear the now-spent state cookie and set the session cookie.
        self._redirect(
            "/",
            [
                self._cookie_header(SESSION_COOKIE, session, self.settings.session_ttl),
                self._cookie_header(STATE_COOKIE, "", 0),
            ],
        )

    def _exchange_code(self, code: str) -> dict:
        resp = requests.post(
            DISCORD_TOKEN_URL,
            data={
                "client_id": self.settings.client_id,
                "client_secret": self.settings.client_secret,
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self.settings.redirect_uri,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=10,
        )
        resp.raise_for_status()
        access_token = resp.json()["access_token"]
        who = requests.get(
            DISCORD_USER_URL,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10,
        )
        who.raise_for_status()
        return who.json()

    def _auth_logout(self):
        self._redirect("/", [self._cookie_header(SESSION_COOKIE, "", 0)])

    def _api_cmd(self, name: str, write: bool):
        if not self._session():
            return self._json(401, {"ok": False, "error": "not authenticated"})

        if name not in COMMANDS:
            return self._json(404, {"ok": False, "error": f"unknown command {name!r}"})

        requires_post = COMMANDS[name]
        if requires_post and not write:
            return self._json(405, {"ok": False, "error": "this command requires POST"})
        if write and not self._same_origin():
            return self._json(403, {"ok": False, "error": "cross-origin request rejected"})

        params = self._read_params(write)
        if params is None:
            return self._json(400, {"ok": False, "error": "invalid JSON body"})

        # Attribute dashboard-triggered runs in the run history.
        if name == "run":
            session = self._session()
            params.setdefault("triggered_by", f"dashboard:{session.get('name', '?')}")

        try:
            result = ipc_call(name, **params)
        except Exception as e:
            logger.exception("dashboard IPC call %r failed", name)
            return self._json(502, {"ok": False, "error": f"IPC error: {e}"})
        return self._json(200, result)

    def _read_params(self, write: bool):
        """Collect command params: JSON body for POST, query string for GET.
        Returns a dict, or None if the JSON body is malformed."""
        if not write:
            raw = parse_qs(urlparse(self.path).query)
            return {k: (v[0] if len(v) == 1 else v) for k, v in raw.items()}
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        body = self.rfile.read(length)
        try:
            data = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return None
        if not isinstance(data, dict):
            return None
        data.pop("cmd", None)
        return data


class _DashboardHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        """Quiet benign client disconnects (same rationale as the webhook
        listener): scanners and probes drop connections mid-request and the
        threaded server shrugs them off — no need to dump a traceback."""
        import sys

        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, BrokenPipeError, TimeoutError)):
            logger.debug("dashboard client %s disconnected: %r", client_address, exc)
            return
        logger.exception("dashboard error handling request from %s", client_address)


class DashboardServer:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._server = _DashboardHTTPServer((settings.host, settings.port), _Handler)
        self._server.settings = settings  # type: ignore[attr-defined]

    def serve_forever(self):
        logger.info(
            "Dashboard listening on http://%s:%s (allowed users: %d)",
            self.settings.host,
            self.settings.port,
            len(self.settings.allowed_users),
        )
        self._server.serve_forever()

    def stop(self):
        try:
            self._server.shutdown()
        finally:
            self._server.server_close()


def main():
    if not logging.getLogger().handlers:
        logging.basicConfig(
            level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
        )

    settings = Settings()
    if not settings.enabled:
        logger.warning("[Dashboard]ENABLED is false — serving /healthz only.")
    elif not settings.active:
        logger.error(
            "Dashboard misconfigured (%s) — serving /healthz only until fixed.",
            settings.misconfigured(),
        )
    # Always bind: an inactive server still answers /healthz so the container
    # stays healthy and flips to the full dashboard once enabled + configured.
    DashboardServer(settings).serve_forever()


if __name__ == "__main__":
    main()
