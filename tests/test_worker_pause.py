"""The watcher worker thread must hold queue work while the bot is paused and
resume once the shared pause flag clears."""
from unittest.mock import patch

import publoader.workers.watcher as watcher


class _FakeStore:
    def __init__(self, sequence):
        # is_paused() returns each value in turn, then False forever.
        self.sequence = list(sequence)

    def is_paused(self):
        return self.sequence.pop(0) if self.sequence else False


def test_returns_immediately_when_not_paused():
    store = _FakeStore([False])
    sleeps = []
    with patch("publoader.state.get_state_store", return_value=store), patch.object(
        watcher.time, "sleep", side_effect=sleeps.append
    ):
        watcher._wait_while_paused("uploader")
    assert sleeps == []  # never slept


def test_blocks_until_unpaused():
    store = _FakeStore([True, True, False])
    sleeps = []
    with patch("publoader.state.get_state_store", return_value=store), patch.object(
        watcher.time, "sleep", side_effect=sleeps.append
    ):
        watcher._wait_while_paused("deleter")
    # Polled twice (two True reads) before the False let it through.
    assert len(sleeps) == 2


def test_fail_open_on_store_error():
    class _BoomStore:
        def is_paused(self):
            raise RuntimeError("db gone")

    with patch("publoader.state.get_state_store", return_value=_BoomStore()), patch.object(
        watcher.time, "sleep"
    ) as slept:
        watcher._wait_while_paused("editor")  # must not raise or hang
    slept.assert_not_called()
