import sqlite3
from pathlib import Path

import pytest

from publoader.state.store import StateStore


@pytest.fixture
def store(tmp_path):
    s = StateStore(tmp_path / "state.db").open()
    yield s
    s.close()


def test_starts_empty(store):
    assert store.has_any_schedule() is False
    assert store.get_schedule_overrides() == {}


def test_upsert_then_read(store):
    store.upsert_schedule("mangaplus", 15, 5, None)
    store.upsert_schedule("webtoon", 22, 0, 3)
    overrides = store.get_schedule_overrides()
    assert overrides == {
        "mangaplus": {"hour": 15, "minute": 5},
        "webtoon": {"hour": 22, "minute": 0, "day": 3},
    }
    assert store.has_any_schedule() is True


def test_upsert_replaces(store):
    store.upsert_schedule("mangaplus", 1, 1, None)
    store.upsert_schedule("mangaplus", 12, 30, 4)
    assert store.get_schedule_overrides() == {
        "mangaplus": {"hour": 12, "minute": 30, "day": 4}
    }


def test_remove(store):
    store.upsert_schedule("mangaplus", 1, 1, None)
    assert store.remove_schedule("mangaplus") == 1
    assert store.remove_schedule("mangaplus") == 0
    assert store.get_schedule_overrides() == {}


def test_run_history(store):
    rid = store.record_run_started("mangaplus", "manual", "user:123")
    assert isinstance(rid, int)
    store.record_run_completed(rid, True)


def test_recent_runs_orders_and_filters(store):
    store.record_run_started("alpha", "run", "discord")
    store.record_run_started("beta", "force", "schedule")
    rid = store.record_run_started("alpha", "clean", "discord")
    store.record_run_completed(rid, True)

    recent = store.recent_runs(limit=10)
    assert [r["extension"] for r in recent] == ["alpha", "beta", "alpha"]
    assert recent[0]["kind"] == "clean"
    assert recent[0]["success"] == 1

    only_alpha = store.recent_runs(limit=10, extension="alpha")
    assert {r["extension"] for r in only_alpha} == {"alpha"}
    assert len(only_alpha) == 2


def test_recent_runs_limit_clamped(store):
    for _ in range(5):
        store.record_run_started("alpha", "run", "discord")
    assert len(store.recent_runs(limit=2)) == 2


def test_pause_flag_round_trip(store):
    import time

    assert store.is_paused() is False
    assert store.get_pause_until() == 0.0

    store.set_setting("pause_until", str(time.time() + 600))
    assert store.is_paused() is True
    assert store.get_pause_until() > 0

    store.set_setting("pause_until", str(time.time() - 5))
    assert store.is_paused() is False


def test_pause_flag_ignores_garbage(store):
    store.set_setting("pause_until", "not-a-number")
    assert store.get_pause_until() == 0.0
    assert store.is_paused() is False


def test_indefinite_pause_flag(store):
    # The scheduler persists an indefinite pause as the string "inf"; workers
    # must read that as "stay paused" rather than falling back to not-paused.
    store.set_setting("pause_until", "inf")
    assert store.get_pause_until() == float("inf")
    assert store.is_paused() is True


def test_exists_on_disk(tmp_path):
    db_path = tmp_path / "state.db"
    s = StateStore(db_path)
    assert s.exists_on_disk() is False
    s.open()
    assert s.exists_on_disk() is True
    s.close()


def test_wal_mode_enabled(store):
    cur = store.conn.execute("PRAGMA journal_mode")
    mode = cur.fetchone()[0]
    assert mode.lower() == "wal"


def test_disable_then_list(store):
    assert store.list_disabled_extensions() == []
    assert store.is_extension_disabled("mangaplus") is False

    assert store.disable_extension("mangaplus") is True
    assert store.disable_extension("webtoon") is True
    # Re-disabling is a no-op, not an error.
    assert store.disable_extension("mangaplus") is False

    assert store.is_extension_disabled("mangaplus") is True
    assert store.list_disabled_extensions() == ["mangaplus", "webtoon"]


def test_enable_removes_disabled(store):
    store.disable_extension("mangaplus")
    assert store.enable_extension("mangaplus") is True
    assert store.enable_extension("mangaplus") is False
    assert store.is_extension_disabled("mangaplus") is False


def test_invalid_extension_name_rejected(store):
    with pytest.raises(ValueError):
        store.disable_extension("Bad-Name")
    with pytest.raises(ValueError):
        store.enable_extension("")
