"""Logging shim for extensions running under the worker runner.

The monolith writes rotating log files under a shared logs/ tree and attaches a
Discord webhook handler to ERROR records. A worker has neither a durable log
volume nor a webhook URL, so every logger here writes to stderr, which the
agent captures, tags with the job id, and forwards to the operator's log
pipeline. stdout is reserved for the result envelope and must stay clean.
"""

import logging
import sys
from pathlib import Path
from typing import Optional

_FORMAT = "%(asctime)s %(levelname)-8s [%(name)s:%(filename)s:%(lineno)d] %(message)s"
_configured = set()


def setup_logs(
    logger_name: str,
    path: Optional[Path] = None,
    logger_filename: Optional[str] = None,
) -> None:
    """Attach a stderr handler to ``logger_name``. ``path`` is accepted and
    ignored so extensions written against the monolith keep working."""
    if logger_name in _configured:
        return
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(_FORMAT))
    log = logging.getLogger(logger_name)
    log.addHandler(handler)
    log.setLevel(logging.DEBUG)
    # Without this the root logger (also on stderr) would double every line.
    log.propagate = False
    _configured.add(logger_name)


def setup_extension_logs(
    logger_name: str,
    logger_filename: Optional[str] = None,
) -> None:
    """Setup the logger for an extension."""
    setup_logs(logger_name=logger_name, logger_filename=logger_filename)


def clear_old_logs(folder_path: Path) -> None:
    """No-op: the runner writes no log files to clean up."""


setup_logs("publoader")
setup_logs("webhook")
