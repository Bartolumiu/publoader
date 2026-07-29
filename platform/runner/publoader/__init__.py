"""Minimal ``publoader`` compatibility package for the worker runner.

Extensions are written against the monolith's ``publoader`` package. Workers
must not carry the monolith: it reaches MongoDB, MangaDex, Discord and the
filesystem, none of which a worker is allowed to touch. This package provides
exactly the symbols extensions import — dataclasses, small pure helpers, a
stderr logger, and inert webhook stubs — and deliberately nothing else, so an
extension that reaches for a credential-holding facility fails loudly at import
time instead of silently getting one.
"""

__all__ = ["models", "utils", "webhook"]
