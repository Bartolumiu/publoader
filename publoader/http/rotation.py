"""Outgoing-IP rotation for the shared requests session.

MangaDex rate-limits and, on abuse, bans by source IP. When the host has more
than one address to send from — a pool of proxies, several bound IPs, or a
routed IPv6 prefix — spreading requests across them keeps any single address
under the radar. Two independent mechanisms are offered:

* **Proxy pool** — a random proxy is chosen per request. Works anywhere; the
  proxies do the source-address spreading. Configured via ``[Network] PROXIES``.
* **Source-address binding** — each outgoing *connection* is bound to a random
  local source IP. Either an explicit list (``SOURCE_IPS``) or addresses
  generated from a routed IPv6 subnet (``SOURCE_IPV6_SUBNET``). This needs the
  host to actually own/route those addresses and to permit non-local binds; see
  docker/README "Outgoing IP rotation".

Both default off, so a stock config keeps the single-outbound-IP behaviour.
"""
import ipaddress
import logging
import random

from requests.adapters import HTTPAdapter
from urllib3 import PoolManager

logger = logging.getLogger("publoader")


def generate_ipv6_pool(subnet: str, count: int) -> "list[str]":
    """Return up to ``count`` distinct random addresses from an IPv6 subnet.

    A /64 holds 2**64 hosts, so we can't enumerate it — we sample random hosts
    (skipping the network address) and de-dupe. Raises ValueError for a
    non-IPv6 or unparseable subnet.
    """
    net = ipaddress.ip_network(subnet, strict=False)
    if net.version != 6:
        raise ValueError(f"SOURCE_IPV6_SUBNET must be IPv6, got {subnet!r}")

    host_bits = net.max_prefixlen - net.prefixlen
    if host_bits == 0:
        # A /128 — the single address is the only choice.
        return [str(net.network_address)]

    base = int(net.network_address)
    span = 1 << host_bits
    seen: "set[int]" = set()
    out: "list[str]" = []
    # Oversample so de-duping still reaches `count`; bound the loop regardless.
    for _ in range(max(count * 8, count + 8)):
        if len(out) >= count:
            break
        offset = random.randrange(1, span) if span > 1 else 0
        if offset in seen:
            continue
        seen.add(offset)
        out.append(str(ipaddress.ip_address(base + offset)))
    return out


class RotatingSourceAddressAdapter(HTTPAdapter):
    """requests adapter that binds each connection to a random source address.

    One urllib3 PoolManager is kept per source address (all built with identical
    options), and ``poolmanager`` returns a random one on every access. So
    connections are reused within a source and rotated across sources — i.e.
    per-connection rotation, which is what actually spreads load across an IP
    pool. All managers share the same TLS/pool options, so the fact that
    requests reads ``poolmanager`` more than once per request is harmless.
    """

    def __init__(self, source_addresses, **kwargs):
        addrs = [a.strip() for a in source_addresses if a and a.strip()]
        if not addrs:
            raise ValueError("source_addresses must be non-empty")
        # De-dupe while preserving order.
        self._source_addresses = list(dict.fromkeys(addrs))
        self._managers: "dict[str, PoolManager]" = {}
        self._default_manager = None
        super().__init__(**kwargs)

    def init_poolmanager(self, connections, maxsize, block=False, **pool_kwargs):
        self._managers = {
            addr: PoolManager(
                num_pools=connections,
                maxsize=maxsize,
                block=block,
                source_address=(addr, 0),
                **pool_kwargs,
            )
            for addr in self._source_addresses
        }
        # A concrete fallback for any access before/without rotation.
        self._default_manager = next(iter(self._managers.values()))

    @property
    def poolmanager(self):
        managers = getattr(self, "_managers", None)
        if managers:
            return random.choice(list(managers.values()))
        return self._default_manager

    @poolmanager.setter
    def poolmanager(self, value):
        self._default_manager = value

    def close(self):
        for manager in getattr(self, "_managers", {}).values():
            try:
                manager.clear()
            except Exception:
                pass
        self._managers = {}
        super().close()


def install_global_proxy_rotation(proxy_pool) -> "bool":
    """Route every ``requests``-based call in this process through a random
    proxy from ``proxy_pool``, unless the caller set proxies explicitly.

    publoader's extensions run in-process and make their own HTTP requests with
    their own ``requests``/``cloudscraper`` sessions — nothing is injected into
    them, so the per-client rotation in HTTPModel never reaches them. Patching
    ``requests.Session.request`` at the class level is the one hook that covers
    all of them at once (cloudscraper subclasses ``requests.Session``). Install
    this once at process startup, before extensions load; forked worker
    processes inherit the patch.

    Idempotent and a no-op for an empty pool. Returns True if rotation is
    active afterwards.
    """
    pool = [p.strip() for p in (proxy_pool or []) if p and p.strip()]
    if not pool:
        return False

    from requests import sessions as _sessions

    original = _sessions.Session.request
    if getattr(original, "_publoader_proxy_rotation", False):
        return True

    def request(self, method, url, **kwargs):
        # Respect an explicit per-request proxy or one set on the session; only
        # fill in when the caller left it unset.
        if kwargs.get("proxies") is None and not getattr(self, "proxies", None):
            proxy = random.choice(pool)
            kwargs["proxies"] = {"http": proxy, "https": proxy}
        return original(self, method, url, **kwargs)

    request._publoader_proxy_rotation = True
    request._publoader_original = original
    _sessions.Session.request = request
    msg = (
        f"Global proxy rotation installed across {len(pool)} proxies "
        f"(requests/cloudscraper, per request; extensions included)."
    )
    logger.info(msg)
    # Also to stdout so it shows in `docker compose logs` — the publoader logger
    # only writes to a file.
    print(msg)
    return True


def install_global_aiohttp_proxy_rotation(proxy_pool) -> "bool":
    """Route aiohttp ``ClientSession``s through a random proxy from the pool.

    aiohttp is a separate HTTP stack from ``requests`` (some extensions use it)
    and has **no native SOCKS support**, so a proxy can only be applied via an
    ``aiohttp_socks`` ProxyConnector supplied when the session is constructed.
    That means **per-session** rotation — a random proxy per ``ClientSession``,
    not per request — for socks5://, socks4:// and http(s):// alike. Patching
    ``ClientSession.__init__`` at the class level is the one hook that reaches
    every aiohttp-based extension without touching its code.

    No-op (returns False) when the pool is empty or aiohttp / aiohttp_socks
    aren't installed — nothing in core publoader depends on them; they only
    arrive alongside an extension that uses aiohttp. Idempotent; install once at
    startup before extensions load (forked workers inherit the patch).
    """
    pool = [p.strip() for p in (proxy_pool or []) if p and p.strip()]
    if not pool:
        return False

    try:
        import aiohttp
        from aiohttp_socks import ProxyConnector
    except ImportError:
        msg = (
            "aiohttp proxy rotation requested but aiohttp/aiohttp_socks are not "
            "installed; aiohttp-based extensions will NOT be proxied."
        )
        logger.warning(msg)
        print(msg)
        return False

    original_init = aiohttp.ClientSession.__init__
    if getattr(original_init, "_publoader_proxy_rotation", False):
        return True

    def __init__(self, *args, **kwargs):
        # Respect an explicitly supplied connector; only inject one when the
        # caller left it to aiohttp's default (a fresh connector is built per
        # session, and the session owns/closes it as usual).
        if kwargs.get("connector") is None:
            proxy = random.choice(pool)
            try:
                kwargs["connector"] = ProxyConnector.from_url(proxy)
            except Exception as e:
                logger.error(
                    "aiohttp proxy connector build failed for %r: %s", proxy, e
                )
        original_init(self, *args, **kwargs)

    __init__._publoader_proxy_rotation = True
    __init__._publoader_original = original_init
    aiohttp.ClientSession.__init__ = __init__
    msg = (
        f"Global aiohttp proxy rotation installed across {len(pool)} proxies "
        f"(per-session; extensions included)."
    )
    logger.info(msg)
    print(msg)
    return True


def apply_ip_rotation(
    session,
    *,
    proxies=None,
    source_ips=None,
    ipv6_subnet=None,
    pool_size=64,
):
    """Configure ``session`` for outgoing-IP rotation.

    Precedence: a non-empty proxy pool wins (and this returns it for the caller
    to apply per-request). Otherwise, explicit source IPs plus any generated
    from ``ipv6_subnet`` are bound via a rotating adapter. Returns the list of
    proxy URLs to rotate per request (empty when proxy mode is off).
    """
    proxy_pool = [p.strip() for p in (proxies or []) if p and p.strip()]
    if proxy_pool:
        logger.info("Outgoing IP rotation: proxy pool (%d proxies).", len(proxy_pool))
        return proxy_pool

    addrs = [a for a in (source_ips or []) if a and a.strip()]
    if ipv6_subnet:
        try:
            generated = generate_ipv6_pool(ipv6_subnet, pool_size)
            addrs.extend(generated)
            logger.info(
                "Outgoing IP rotation: generated %d source address(es) from %s.",
                len(generated),
                ipv6_subnet,
            )
        except Exception as e:
            logger.error(
                "Outgoing IP rotation: could not build IPv6 pool from %r: %s",
                ipv6_subnet,
                e,
            )

    if addrs:
        try:
            adapter = RotatingSourceAddressAdapter(addrs)
        except ValueError:
            return []
        session.mount("http://", adapter)
        session.mount("https://", adapter)
        logger.info(
            "Outgoing IP rotation: binding connections to %d source IP(s).",
            len(adapter._source_addresses),
        )

    return []
