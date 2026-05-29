"""Input-validation tests for the /pull IPC command.

The real download + tarball-extract path is exercised by `PubloaderUpdater`
directly and is networked, so these tests just confirm cmd_pull handles
arg parsing, alias expansion, and unknown repos without touching GitHub."""
import logging
from unittest.mock import patch, MagicMock

import pytest

import run as run_module


class _FakeUpdater:
    """Stand-in for PubloaderUpdater. Records which repos update_one() was
    called for so the test can assert routing without hitting GitHub."""

    def __init__(self):
        self.calls = []

    def update_one(self, name):
        self.calls.append(name)
        return {"ok": True, "changed": False, "sha": "deadbeef"}


@pytest.fixture
def pull_handler():
    """Build a real IPC server with mocked socket, return its `pull` handler.

    `_setup_ipc_server` defines `cmd_pull` as a closure, so the only way to
    reach it is to let it register on a server we can inspect."""
    captured: dict = {}

    class _SpyServer:
        def register(self, name, fn):
            captured[name] = fn

        def start(self):
            pass

    with patch.object(run_module, "IPCServer", return_value=_SpyServer()):
        run_module._setup_ipc_server(database_connection=MagicMock())
    return captured["pull"]


def test_pull_rejects_empty(pull_handler):
    assert pull_handler({}) == {"ok": False, "error": "no repos requested"}


def test_pull_rejects_unknown_repo(pull_handler):
    fake = _FakeUpdater()
    with patch.object(run_module, "PubloaderUpdater", return_value=fake):
        result = pull_handler({"repos": ["nonsense"]})
    assert result["ok"] is False
    assert result["repos"]["nonsense"]["ok"] is False
    assert "unknown repo" in result["repos"]["nonsense"]["error"]
    assert fake.calls == []


def test_pull_all_alias_expands_to_known_repos(pull_handler):
    fake = _FakeUpdater()
    with patch.object(run_module, "PubloaderUpdater", return_value=fake):
        result = pull_handler({"repos": ["all"]})
    assert result["ok"] is True
    assert set(fake.calls) == set(run_module._PULL_REPOS)


def test_pull_single_repo_routes_to_update_one(pull_handler):
    fake = _FakeUpdater()
    with patch.object(run_module, "PubloaderUpdater", return_value=fake):
        result = pull_handler({"repo": "extensions"})
    assert result["ok"] is True
    assert fake.calls == ["extensions"]
    assert result["repos"]["extensions"]["sha"] == "deadbeef"


def test_pull_reports_changed_when_any_repo_updated(pull_handler):
    class _MixedUpdater:
        def __init__(self):
            self.calls = []

        def update_one(self, name):
            self.calls.append(name)
            if name == "extensions":
                return {"ok": True, "changed": True, "sha": "newsha", "previous": "old"}
            return {"ok": True, "changed": False, "sha": "samesha"}

    mixed = _MixedUpdater()
    with patch.object(run_module, "PubloaderUpdater", return_value=mixed):
        result = pull_handler({"repos": ["base", "extensions"]})
    assert result["ok"] is True
    assert result["changed"] is True


def test_pull_propagates_updater_init_failure(pull_handler, caplog):
    # cmd_pull logs.exception() on init failure — capture the traceback at
    # ERROR level instead of letting it spill onto the test runner's stderr.
    with caplog.at_level(logging.CRITICAL, logger="publoader"), patch.object(
        run_module,
        "PubloaderUpdater",
        side_effect=RuntimeError("github_access_token missing"),
    ):
        result = pull_handler({"repos": ["base"]})
    assert result["ok"] is False
    assert "github_access_token missing" in result["error"]
