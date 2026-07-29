"""In-process egress allowlist for extension code.

The manifest's ``allowed_hosts`` is enforced policy, not documentation. Rather
than trying to hook every HTTP library an extension might reach for (requests,
aiohttp, httpx, raw sockets), this guards the two chokepoints every one of them
goes through:

* ``socket.getaddrinfo`` — resolves the hostname. Denying here stops the
  connection before a packet leaves, and it is what ``requests``/urllib3,
  ``aiohttp``, and ``asyncio.loop.create_connection`` all call.
* ``socket.socket.connect`` — catches code that skips resolution by dialling a
  literal IP address.

Raw-IP connections are refused unless that IP came back from an allowed
hostname during this run. That is the simplest rule that cannot be walked
around by hardcoding an address, and it costs nothing for extensions that use
hostnames like every real one does.
"""

import ipaddress
import socket
import sys
from typing import Iterable, List, Sequence, Set

__all__ = ["EgressDenied", "install_allowlist", "denied_hosts"]

_orig_getaddrinfo = socket.getaddrinfo
_orig_gethostbyname = socket.gethostbyname
_orig_connect = socket.socket.connect

#: Hosts an extension tried and failed to reach, for the run summary.
denied_hosts: List[str] = []

_installed = False


class EgressDenied(OSError):
    """Raised in place of a connection to a host outside the manifest."""


def _normalise(host: str) -> str:
    return host.strip().strip(".").lower()


def _host_allowed(host: str, allowed: Sequence[str]) -> bool:
    candidate = _normalise(host)
    if not candidate:
        return False
    for entry in allowed:
        if candidate == entry or candidate.endswith("." + entry):
            return True
    return False


def _deny(target: str, allowed: Sequence[str]) -> EgressDenied:
    denied_hosts.append(target)
    message = (
        "egress denied: %r is not in the extension manifest's allowed_hosts (%s)"
        % (target, ", ".join(allowed) or "<empty>")
    )
    print("hostguard: " + message, file=sys.stderr, flush=True)
    return EgressDenied(message)


def _as_ip(value) -> "ipaddress._BaseAddress | None":
    if value is None:
        return None
    text = value.decode("ascii", "ignore") if isinstance(value, bytes) else str(value)
    text = text.strip().strip("[]")
    if "%" in text:  # IPv6 scope id
        text = text.split("%", 1)[0]
    try:
        return ipaddress.ip_address(text)
    except ValueError:
        return None


def install_allowlist(
    allowed_hosts: Iterable[str], allow_loopback: bool = False
) -> None:
    """Patch the socket module so only ``allowed_hosts`` are reachable.

    Must be called *before* the extension module is imported: libraries that
    cache a reference to ``socket.getaddrinfo`` at import time would otherwise
    keep the unguarded original.
    """
    global _installed
    if _installed:
        return

    allowed = [
        _normalise(h).lstrip("*.") for h in allowed_hosts if h and str(h).strip()
    ]
    allowed = [h for h in allowed if h]
    resolved_ips: Set[str] = set()

    def guarded_getaddrinfo(host, port, *args, **kwargs):
        literal = _as_ip(host)
        if literal is not None:
            if str(literal) in resolved_ips or (allow_loopback and literal.is_loopback):
                return _orig_getaddrinfo(host, port, *args, **kwargs)
            raise _deny(str(literal), allowed)

        name = host.decode("idna") if isinstance(host, bytes) else str(host or "")
        if allow_loopback and _normalise(name) in ("localhost", ""):
            return _orig_getaddrinfo(host, port, *args, **kwargs)
        if not _host_allowed(name, allowed):
            raise _deny(name, allowed)

        results = _orig_getaddrinfo(host, port, *args, **kwargs)
        for entry in results:
            sockaddr = entry[4]
            if sockaddr and isinstance(sockaddr, tuple):
                ip = _as_ip(sockaddr[0])
                if ip is not None:
                    resolved_ips.add(str(ip))
        return results

    def guarded_gethostbyname(hostname):
        # Routed through the guard rather than the C resolver so this legacy
        # entrypoint cannot be used to sidestep the allowlist.
        info = guarded_getaddrinfo(hostname, None, socket.AF_INET)
        return info[0][4][0]

    def guarded_connect(self, address):
        if self.family == getattr(socket, "AF_UNIX", None):
            return _orig_connect(self, address)
        host = address[0] if isinstance(address, tuple) and address else address
        ip = _as_ip(host)
        if ip is None:
            # A hostname reached connect() unresolved; apply the name rule.
            if not _host_allowed(str(host), allowed):
                raise _deny(str(host), allowed)
            return _orig_connect(self, address)
        if str(ip) in resolved_ips or (allow_loopback and ip.is_loopback):
            return _orig_connect(self, address)
        raise _deny(str(ip), allowed)

    socket.getaddrinfo = guarded_getaddrinfo
    socket.gethostbyname = guarded_gethostbyname
    socket.socket.connect = guarded_connect
    _installed = True
    print(
        "hostguard: egress restricted to %s" % (", ".join(allowed) or "<nothing>"),
        file=sys.stderr,
        flush=True,
    )
