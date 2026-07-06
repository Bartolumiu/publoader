"""Tests for the Discord remote-control IPC handlers added to run.py.

Like test_pull.py these reach the closure-defined handlers by registering them
on a spy server, then drive them with fakes so nothing touches Mongo, the real
config.ini, or the filesystem outside tmp."""
import base64
import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest

import run as run_module


# ---------- fake Mongo ----------


class _FakeCollection:
    def __init__(self, docs=None):
        self.docs = list(docs or [])

    def count_documents(self, _q):
        return len(self.docs)

    def find(self, _q, limit=0):
        return self.docs[:limit] if limit else list(self.docs)

    def delete_many(self, _q):
        n = len(self.docs)
        self.docs.clear()
        return SimpleNamespace(deleted_count=n)


class _FakeDB:
    def __init__(self, mapping=None):
        self.mapping = dict(mapping or {})

    def __getitem__(self, name):
        return self.mapping.setdefault(name, _FakeCollection())

    def list_collection_names(self):
        return list(self.mapping)


def _build_handlers(db):
    """Register run.py's IPC handlers on a spy server and return them by name."""
    captured = {}

    class _SpyServer:
        def register(self, name, fn):
            captured[name] = fn

        def start(self):
            pass

    with patch.object(run_module, "IPCServer", return_value=_SpyServer()):
        run_module._setup_ipc_server(database_connection=db)
    return captured


@pytest.fixture
def handlers():
    db = _FakeDB(
        {
            "to_upload": _FakeCollection(
                [
                    {
                        "_id": "a1",
                        "md_chapter_id": "ch1",
                        "manga_id": "m1",
                        "chapter_number": "12",
                        "extension_name": "demo",
                    },
                    {"_id": "a2", "md_chapter_id": "ch2"},
                ]
            ),
            "to_delete": _FakeCollection(),
            "to_edit": _FakeCollection(),
            "to_unavailable": _FakeCollection(),
        }
    )
    return _build_handlers(db), db


# ---------- queue_peek / queue_clear ----------


def test_queue_peek_returns_sample(handlers):
    h, _db = handlers
    result = h["queue_peek"]({"worker": "uploader", "limit": 5})
    assert result["ok"] is True
    assert result["table"] == "to_upload"
    assert result["queued"] == 2
    assert result["sample"][0]["md_chapter_id"] == "ch1"


def test_queue_peek_rejects_unknown_worker(handlers):
    h, _db = handlers
    result = h["queue_peek"]({"worker": "bogus"})
    assert result["ok"] is False
    assert "unknown worker" in result["error"]


def test_queue_clear_empties_collection(handlers):
    h, db = handlers
    result = h["queue_clear"]({"worker": "uploader"})
    assert result["ok"] is True
    assert result["deleted"] == 2
    assert db["to_upload"].count_documents({}) == 0


def test_queue_clear_rejects_unknown_worker(handlers):
    h, _db = handlers
    assert h["queue_clear"]({"worker": "nope"})["ok"] is False


# ---------- stats ----------


def test_stats_reports_queue_depth(handlers):
    h, _db = handlers
    result = h["stats"]({})
    assert result["ok"] is True
    assert result["queues"]["uploader"] == 2
    assert result["queues"]["deleter"] == 0
    # to_upload is also a known collection name -> appears under collections.
    assert result["collections"]["to_upload"] == 2


# ---------- config_show / config_set ----------


def test_config_show_redacts_secrets(handlers):
    h, _db = handlers
    result = h["config_show"]({"section": "Credentials"})
    assert result["ok"] is True
    creds = result["config"]["Credentials"]
    # Any set secret must be masked, never echoed verbatim.
    for secret_key in ("discord_bot_token", "mongodb_uri", "client_secret"):
        if creds.get(secret_key):
            assert creds[secret_key].startswith("***")


def test_config_show_unknown_section(handlers):
    h, _db = handlers
    assert h["config_show"]({"section": "Nope"})["ok"] is False


def test_config_set_rejects_unknown_section(handlers):
    h, _db = handlers
    result = h["config_set"]({"section": "Nope", "key": "x", "value": "1"})
    assert result["ok"] is False
    assert "unknown section" in result["error"]


def test_config_set_requires_key_and_value(handlers):
    h, _db = handlers
    assert h["config_set"]({"section": "Options", "value": "1"})["ok"] is False
    assert h["config_set"]({"section": "Options", "key": "x"})["ok"] is False


# ---------- logs ----------


def test_logs_lists_scopes_when_no_scope(handlers):
    h, _db = handlers
    result = h["logs"]({})
    assert result["ok"] is True
    assert "bot" in result["scopes"]
    assert "uploader" in result["workers"]


def test_logs_rejects_unknown_scope(handlers):
    h, _db = handlers
    assert h["logs"]({"scope": "nonsense"})["ok"] is False


def test_logs_tails_file(tmp_path, handlers):
    h, _db = handlers
    folder = tmp_path / "logs" / "bot"
    folder.mkdir(parents=True)
    (folder / "publoader_2026-01-01.log").write_text(
        "line1\nline2\nline3\n", encoding="utf-8"
    )
    with patch.object(run_module, "root_path", tmp_path):
        result = h["logs"]({"scope": "bot", "lines": 2})
    assert result["ok"] is True
    assert result["text"] == "line2\nline3"


# ---------- mdauth_status ----------


def _make_jwt(exp):
    payload = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=")
    return f"header.{payload}.sig"


def test_mdauth_status_missing_file(tmp_path, handlers):
    h, _db = handlers
    with patch.object(run_module, "root_path", tmp_path):
        result = h["mdauth_status"]({})
    assert result["ok"] is True
    assert result["exists"] is False


def test_mdauth_status_decodes_expiry(tmp_path, handlers):
    h, _db = handlers
    res_dir = tmp_path / "resources"
    res_dir.mkdir()
    (res_dir / "mdauth.json").write_text(
        json.dumps({"access": _make_jwt(4102444800), "refresh": "r"}),
        encoding="utf-8",
    )
    with patch.object(run_module, "root_path", tmp_path):
        result = h["mdauth_status"]({})
    assert result["ok"] is True
    assert result["exists"] is True
    assert result["has_access"] is True
    assert result["access_expired"] is False


# ---------- run_history ----------


def test_run_history_passthrough(handlers, monkeypatch):
    h, _db = handlers

    class _FakeStore:
        def recent_runs(self, limit, extension):
            return [{"id": 1, "extension": extension or "all", "kind": "run"}]

    monkeypatch.setattr(run_module, "get_state_store", lambda: _FakeStore())
    result = h["run_history"]({"limit": 5})
    assert result["ok"] is True
    assert result["runs"][0]["extension"] == "all"


def test_run_history_rejects_bad_extension(handlers):
    h, _db = handlers
    assert h["run_history"]({"extension": "Bad Name!"})["ok"] is False


# ---------- pause / resume ----------


class _FakeStore:
    def __init__(self):
        self.settings = {}

    def set_setting(self, key, value):
        self.settings[key] = value

    def clear_setting(self, key):
        return self.settings.pop(key, None)

    def get_setting(self, key):
        return self.settings.get(key)


@pytest.fixture(autouse=True)
def _reset_pause():
    # cmd_run consults the module-global pause deadline; keep tests isolated.
    run_module._pause_until = 0.0
    yield
    run_module._pause_until = 0.0


@pytest.fixture
def paused_handlers(handlers, monkeypatch):
    h, db = handlers
    monkeypatch.setattr(run_module, "get_state_store", lambda: _FakeStore())
    return h, db


def test_pause_sets_deadline(paused_handlers):
    h, _db = paused_handlers
    result = h["pause"]({"minutes": 10})
    assert result["ok"] is True
    assert result["paused"] is True
    assert result["resumes_in_seconds"] > 0
    assert run_module._is_paused() is True


def test_pause_rejects_out_of_range(paused_handlers):
    h, _db = paused_handlers
    assert h["pause"]({"minutes": -5})["ok"] is False
    assert h["pause"]({"minutes": 5000})["ok"] is False
    assert h["pause"]({"minutes": "abc"})["ok"] is False


def test_pause_indefinite_with_no_minutes(paused_handlers):
    h, _db = paused_handlers
    result = h["pause"]({})
    assert result["ok"] is True
    assert result["paused"] is True
    assert result["indefinite"] is True
    assert result["resumes_in_seconds"] is None
    assert run_module._is_paused() is True
    assert run_module._is_paused_indefinitely() is True


def test_pause_indefinite_with_zero_minutes(paused_handlers):
    h, _db = paused_handlers
    result = h["pause"]({"minutes": 0})
    assert result["ok"] is True
    assert result["indefinite"] is True
    assert run_module._is_paused_indefinitely() is True


def test_status_reports_indefinite_pause(paused_handlers):
    h, _db = paused_handlers
    h["pause"]({})
    status = h["status"]({})
    assert status["paused"] is True
    assert status["pause_indefinite"] is True
    assert status["pause_remaining_seconds"] is None


def test_indefinite_pause_persists_and_reloads(paused_handlers, monkeypatch):
    h, _db = paused_handlers
    # Reuse one store so the persisted deadline survives the reload.
    store = _FakeStore()
    monkeypatch.setattr(run_module, "get_state_store", lambda: store)
    h["pause"]({})
    assert store.settings["pause_until"] == "inf"
    run_module._pause_until = 0.0
    run_module._load_pause_until()
    assert run_module._is_paused_indefinitely() is True


def test_resume_clears_pause(paused_handlers):
    h, _db = paused_handlers
    h["pause"]({"minutes": 30})
    result = h["resume"]({})
    assert result["ok"] is True
    assert result["was_paused"] is True
    assert run_module._is_paused() is False


def test_run_rejected_while_paused(paused_handlers):
    h, _db = paused_handlers
    h["pause"]({"minutes": 30})
    result = h["run"]({"extensions": ["demo"]})
    assert result["queued"] is False
    assert result["paused"] is True


def test_status_reports_pause(paused_handlers):
    h, _db = paused_handlers
    h["pause"]({"minutes": 30})
    status = h["status"]({})
    assert status["paused"] is True
    assert status["pause_remaining_seconds"] > 0


# ---------- force_login / logout ----------


class _FakeOAuth:
    def __init__(self, ok=True):
        self._ok = ok
        self._OAuth2__access_token = "a"
        self._OAuth2__refresh_token = "r"

    def login(self):
        return self._ok


class _FakeClient:
    login_ok = True

    def __init__(self):
        self.oauth = _FakeOAuth(self.login_ok)
        self.access_token = "acc"
        self.refresh_token = "ref"
        self.saved = None
        self._first_login = False
        self._successful_login = True

    def _update_headers(self, _tok):
        pass

    def _save_tokens(self, access, refresh):
        self.saved = (access, refresh)

    def login(self):
        pass


def test_force_login_success(handlers, monkeypatch):
    h, _db = handlers
    monkeypatch.setattr("publoader.http.client.HTTPClient", _FakeClient)
    result = h["force_login"]({})
    assert result["ok"] is True
    assert result["logged_in"] is True
    assert result["forced"] is True


def test_force_login_failure(handlers, monkeypatch):
    h, _db = handlers

    class _RejectClient(_FakeClient):
        login_ok = False

    monkeypatch.setattr("publoader.http.client.HTTPClient", _RejectClient)
    result = h["force_login"]({})
    assert result["ok"] is False
    assert "rejected" in result["error"]


def test_logout_removes_token_file(tmp_path, handlers, monkeypatch):
    h, _db = handlers
    res_dir = tmp_path / "resources"
    res_dir.mkdir()
    token = res_dir / "mdauth.json"
    token.write_text(json.dumps({"access": "x", "refresh": "y"}), encoding="utf-8")

    monkeypatch.setattr(run_module, "root_path", tmp_path)
    monkeypatch.setattr("publoader.http.client.HTTPClient", _FakeClient)
    result = h["logout"]({})
    assert result["ok"] is True
    assert result["file_removed"] is True
    assert not token.exists()


def test_logout_when_no_token_file(tmp_path, handlers, monkeypatch):
    h, _db = handlers
    monkeypatch.setattr(run_module, "root_path", tmp_path)
    monkeypatch.setattr("publoader.http.client.HTTPClient", _FakeClient)
    result = h["logout"]({})
    assert result["ok"] is True
    assert result["file_removed"] is False
