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
import os
import random
import re
from urllib.parse import urlsplit

from requests.adapters import HTTPAdapter
from urllib3 import PoolManager

logger = logging.getLogger("publoader")


def _normalise_no_proxy(hosts) -> "list[str]":
    """Return a de-duped, lower-cased list of no-proxy host patterns.

    Accepts an iterable and/or the standard ``NO_PROXY``/``no_proxy`` env vars
    (comma-separated), merging both. Entries are hostnames or domain suffixes;
    a leading dot is stripped so ``.example.com`` and ``example.com`` behave the
    same (both match the domain and its subdomains).
    """
    out: "list[str]" = []
    seen: "set[str]" = set()

    def add(raw):
        for part in re.split(r"[,\s]+", str(raw or "")):
            part = part.strip().lower().lstrip(".")
            if part and part not in seen:
                seen.add(part)
                out.append(part)

    for h in hosts or []:
        add(h)
    add(os.environ.get("NO_PROXY", ""))
    add(os.environ.get("no_proxy", ""))
    return out


def _host_excluded(url, no_proxy) -> "bool":
    """True if ``url``'s host should bypass the proxy per the no-proxy list.

    Matches an exact host, or a domain suffix (``example.com`` matches
    ``db.example.com``). ``*`` disables proxying entirely, mirroring the
    conventional ``NO_PROXY=*``.
    """
    if not no_proxy:
        return False
    try:
        host = (urlsplit(url).hostname or "").lower()
    except ValueError:
        return False
    if not host:
        return False
    for pattern in no_proxy:
        if pattern == "*":
            return True
        if host == pattern or host.endswith("." + pattern):
            return True
    return False


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


def install_global_proxy_rotation(proxy_pool, no_proxy_hosts=None) -> "bool":
    """Route every ``requests``-based call in this process through a random
    proxy from ``proxy_pool``, unless the caller set proxies explicitly.

    publoader's extensions run in-process and make their own HTTP requests with
    their own ``requests``/``cloudscraper`` sessions — nothing is injected into
    them, so the per-client rotation in HTTPModel never reaches them. Patching
    ``requests.Session.request`` at the class level is the one hook that covers
    all of them at once (cloudscraper subclasses ``requests.Session``). Install
    this once at process startup, before extensions load; forked worker
    processes inherit the patch.

    ``no_proxy_hosts`` names hosts that must NEVER be proxied — chiefly the
    MongoDB host. The DB driver (pymongo) uses raw sockets and isn't touched by
    this patch, but ``pymongo[ocsp]`` pulls in ``requests`` and makes OCSP
    responder calls over it during TLS handshakes, so a stray requests-based
    call toward the DB (or its cert's OCSP responder) would otherwise be
    proxied. The standard ``NO_PROXY``/``no_proxy`` env vars are merged in too.

    Idempotent and a no-op for an empty pool. Returns True if rotation is
    active afterwards.
    """
    pool = [p.strip() for p in (proxy_pool or []) if p and p.strip()]
    if not pool:
        return False

    no_proxy = _normalise_no_proxy(no_proxy_hosts)

    from requests import sessions as _sessions

    original = _sessions.Session.request
    if getattr(original, "_publoader_proxy_rotation", False):
        return True

    def request(self, method, url, **kwargs):
        # Respect an explicit per-request proxy or one set on the session, and
        # never proxy an excluded host (e.g. the DB); only fill in otherwise.
        if (
            kwargs.get("proxies") is None
            and not getattr(self, "proxies", None)
            and not _host_excluded(url, no_proxy)
        ):
            proxy = random.choice(pool)
            kwargs["proxies"] = {"http": proxy, "https": proxy}
        return original(self, method, url, **kwargs)

    request._publoader_proxy_rotation = True
    request._publoader_original = original
    _sessions.Session.request = request
    excluded = f"; {len(no_proxy)} host(s) excluded" if no_proxy else ""
    msg = (
        f"Global proxy rotation installed across {len(pool)} proxies "
        f"(requests/cloudscraper, per request; extensions included){excluded}."
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


# ---------------------------------------------------------------------------
# Extension header spoofing
# ---------------------------------------------------------------------------
#
# The MangaDex client (HTTPModel) identifies honestly as ``publoader/<version>``
# — that is the courteous, expected identity for our own API traffic and MUST
# NOT be spoofed. The *extensions*, however, scrape third-party sites that fend
# off bots by fingerprinting the default ``python-requests/x.y`` (or bare
# aiohttp) User-Agent. Presenting a coherent, real-browser header set makes each
# extension session look like an ordinary user's browser tab.
#
# Each profile below is internally consistent: the User-Agent, the ``Sec-CH-UA``
# client-hint trio and the platform all describe the *same* browser/OS, because
# a mismatched set (e.g. a Chrome UA with a Firefox-shaped header list) is itself
# a bot tell. The MangaDex session opts out via the ``_publoader_no_spoof``
# marker (see HTTPModel), so this never touches our first-party traffic.

_BROWSER_PROFILES = (
    {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        ),
        "Sec-CH-UA": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "Sec-CH-UA-Mobile": "?0",
        "Sec-CH-UA-Platform": '"Windows"',
    },
    {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        ),
        "Sec-CH-UA": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "Sec-CH-UA-Mobile": "?0",
        "Sec-CH-UA-Platform": '"macOS"',
    },
    {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) "
            "Gecko/20100101 Firefox/133.0"
        ),
        # Firefox does not send Sec-CH-UA client hints.
    },
    {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) "
            "Gecko/20100101 Firefox/133.0"
        ),
    },
    {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
            "(KHTML, like Gecko) Version/18.1 Safari/605.1.15"
        ),
        # Safari does not send Sec-CH-UA client hints either.
    },
    {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
        ),
        "Sec-CH-UA": '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "Sec-CH-UA-Mobile": "?0",
        "Sec-CH-UA-Platform": '"Windows"',
    },
    {
        "User-Agent": (
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
        ),
        "Sec-CH-UA": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "Sec-CH-UA-Mobile": "?1",
        "Sec-CH-UA-Platform": '"Android"',
    },
)

# Headers common to every profile — a normal browser sends these on essentially
# every navigation regardless of engine.
_COMMON_SPOOF_HEADERS = {
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,image/apng,*/*;q=0.8"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
}


def random_browser_headers() -> "dict":
    """Return a coherent, real-browser header set for one spoofed session.

    Combines a randomly chosen browser/OS profile with the common navigation
    headers. Every returned dict is self-consistent (UA matches the client-hint
    headers), so a site fingerprinting the combination sees a plausible browser.
    """
    profile = random.choice(_BROWSER_PROFILES)
    return {**_COMMON_SPOOF_HEADERS, **profile}


def install_global_header_spoofing(enabled: "bool" = True) -> "bool":
    """Make every in-process ``requests``/``cloudscraper`` session present as a
    real browser, so extension scrapers dodge default-User-Agent bot filters.

    Like the proxy hook, this patches ``requests.Session.request`` at the class
    level — the single seam that reaches every extension without touching its
    code. The first request a session makes picks one browser profile and pins
    it onto ``session.headers`` (via ``setdefault``, so any header the extension
    set itself always wins); every later request from that same session reuses
    it. Pinning per session — rather than randomising per request — is the point:
    a real user's browser keeps a stable identity for the life of a session, and
    flipping User-Agent between requests would itself look automated.

    Two sessions are left strictly alone: any marked ``_publoader_no_spoof``
    (the MangaDex client, which must stay ``publoader/<version>``), and any that
    already carries our spoof (idempotent per session). Install once at startup
    before extensions load; forked workers inherit the patch. No-op when
    disabled. Returns True if spoofing is active afterwards.
    """
    if not enabled:
        return False

    from requests import sessions as _sessions
    from requests.utils import default_headers as _requests_default_headers

    # requests pre-seeds every Session with User-Agent (``python-requests/x``),
    # Accept, Accept-Encoding and Connection. Those library defaults are exactly
    # the bot tells we want to overwrite — but a value the *extension* set is
    # not, so we replace a header only when it is still at the library default
    # (or absent), and leave anything customised alone.
    _lib_defaults = _requests_default_headers()

    original = _sessions.Session.request
    if getattr(original, "_publoader_header_spoof", False):
        return True

    def request(self, method, url, **kwargs):
        if not getattr(self, "_publoader_no_spoof", False) and not getattr(
            self, "_publoader_spoof_applied", False
        ):
            for key, value in random_browser_headers().items():
                current = self.headers.get(key)
                if current is None or current == _lib_defaults.get(key):
                    self.headers[key] = value
            self._publoader_spoof_applied = True
        return original(self, method, url, **kwargs)

    request._publoader_header_spoof = True
    request._publoader_original = original
    _sessions.Session.request = request
    msg = (
        "Global header spoofing installed (requests/cloudscraper; per session; "
        "extensions present as real browsers, MangaDex client exempt)."
    )
    logger.info(msg)
    print(msg)
    return True


def install_global_aiohttp_header_spoofing(enabled: "bool" = True) -> "bool":
    """Give every aiohttp ``ClientSession`` real-browser default headers.

    aiohttp is a separate HTTP stack from ``requests`` (some extensions use it),
    so it needs its own hook. Patching ``ClientSession.__init__`` injects a
    randomly chosen browser profile as the session's default headers — one
    identity per session, mirroring the requests hook. Any header the caller
    passed to the constructor wins over ours (caller headers layer on top).

    No MangaDex traffic goes through aiohttp, so there is no opt-out to honour
    here. No-op (returns False) when disabled or aiohttp isn't installed —
    nothing in core publoader depends on it; it only arrives with an extension.
    Idempotent; install once at startup before extensions load.
    """
    if not enabled:
        return False

    try:
        import aiohttp
    except ImportError:
        return False

    original_init = aiohttp.ClientSession.__init__
    if getattr(original_init, "_publoader_header_spoof", False):
        return True

    def __init__(self, *args, **kwargs):
        # Layer our browser defaults *under* any headers the caller supplied,
        # so an extension that sets its own headers is never overridden.
        spoofed = random_browser_headers()
        caller_headers = kwargs.get("headers")
        if caller_headers:
            spoofed.update(dict(caller_headers))
        kwargs["headers"] = spoofed
        original_init(self, *args, **kwargs)

    __init__._publoader_header_spoof = True
    __init__._publoader_original = original_init
    aiohttp.ClientSession.__init__ = __init__
    msg = (
        "Global aiohttp header spoofing installed (per session; extensions "
        "present as real browsers)."
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
