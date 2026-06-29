"""Tests for the liveness heartbeat that backs the container healthcheck.

run.py writes a heartbeat file from a daemon thread; the docker-compose
healthcheck treats a stale/missing file as a wedged process so autoheal can
restart it. These tests assert the file is written and that the same staleness
logic the healthcheck uses flips correctly."""
import time
from pathlib import Path

import run as run_module


def test_start_heartbeat_writes_fresh_timestamp(tmp_path, monkeypatch):
    hb = tmp_path / "heartbeat"
    monkeypatch.setattr(run_module, "HEARTBEAT_PATH", hb)

    run_module._start_heartbeat()  # writes one beat synchronously before threading

    assert hb.exists()
    written = float(hb.read_text())
    assert time.time() - written < 5


def _healthy(path: Path) -> bool:
    # Mirror of the healthcheck one-liner in docker-compose.yml.
    return path.exists() and time.time() - float(path.read_text() or 0) < 60


def test_healthcheck_logic_fresh_stale_missing(tmp_path):
    hb = tmp_path / "heartbeat"

    hb.write_text(str(time.time()))
    assert _healthy(hb) is True

    hb.write_text(str(time.time() - 120))
    assert _healthy(hb) is False

    hb.unlink()
    assert _healthy(hb) is False
