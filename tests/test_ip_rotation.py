"""Tests for outgoing-IP rotation (publoader/http/rotation.py).

Covers the IPv6 address-pool generator, the rotating source-address adapter
(one PoolManager per source, random selection, clean close), and the
apply_ip_rotation wiring/precedence. No real network traffic is sent.
"""
import ipaddress

import pytest
import requests

from requests import sessions as _sessions

from publoader.http.rotation import (
    RotatingSourceAddressAdapter,
    _host_excluded,
    _normalise_no_proxy,
    apply_ip_rotation,
    generate_ipv6_pool,
    install_global_aiohttp_proxy_rotation,
    install_global_proxy_rotation,
)
from publoader.utils.config import _mongo_hosts


@pytest.fixture
def restore_session_request():
    """Undo the global Session.request monkeypatch after a test."""
    original = _sessions.Session.request
    yield
    _sessions.Session.request = original


@pytest.fixture
def restore_aiohttp_init():
    """Undo the global aiohttp ClientSession.__init__ monkeypatch after a test."""
    aiohttp = pytest.importorskip("aiohttp")
    pytest.importorskip("aiohttp_socks")
    original = aiohttp.ClientSession.__init__
    yield aiohttp
    aiohttp.ClientSession.__init__ = original


def test_generate_ipv6_pool_within_subnet_and_distinct():
    subnet = "2001:db8:abcd::/64"
    net = ipaddress.ip_network(subnet)
    pool = generate_ipv6_pool(subnet, 50)

    assert len(pool) == 50
    assert len(set(pool)) == 50  # distinct
    for addr in pool:
        ip = ipaddress.ip_address(addr)
        assert ip in net
        assert ip != net.network_address  # network address is skipped


def test_generate_ipv6_pool_small_prefix_caps_at_available():
    # /126 has 4 addresses; minus the network address, at most 3 distinct hosts.
    pool = generate_ipv6_pool("2001:db8::/126", 10)
    assert 0 < len(pool) <= 3
    assert len(set(pool)) == len(pool)


def test_generate_ipv6_pool_single_128():
    pool = generate_ipv6_pool("2001:db8::5/128", 8)
    assert pool == ["2001:db8::5"]


def test_generate_ipv6_pool_rejects_ipv4():
    with pytest.raises(ValueError):
        generate_ipv6_pool("192.0.2.0/24", 4)


def test_adapter_builds_one_manager_per_source():
    addrs = ["2001:db8::1", "2001:db8::2", "2001:db8::3"]
    adapter = RotatingSourceAddressAdapter(addrs)

    assert set(adapter._managers) == set(addrs)
    for addr, manager in adapter._managers.items():
        assert manager.connection_pool_kw["source_address"] == (addr, 0)


def test_adapter_poolmanager_selects_from_pool():
    addrs = ["2001:db8::1", "2001:db8::2"]
    adapter = RotatingSourceAddressAdapter(addrs)
    valid = set(adapter._managers.values())
    # Every access returns one of the per-source managers.
    for _ in range(20):
        assert adapter.poolmanager in valid


def test_adapter_dedupes_sources():
    adapter = RotatingSourceAddressAdapter(["2001:db8::1", "2001:db8::1", " "])
    assert adapter._source_addresses == ["2001:db8::1"]


def test_adapter_empty_raises():
    with pytest.raises(ValueError):
        RotatingSourceAddressAdapter([" ", ""])


def test_adapter_close_clears_managers():
    adapter = RotatingSourceAddressAdapter(["2001:db8::1", "2001:db8::2"])
    adapter.close()
    assert adapter._managers == {}


def test_apply_rotation_proxy_pool_takes_precedence():
    session = requests.Session()
    pool = apply_ip_rotation(
        session,
        proxies=["http://1.2.3.4:8080", " ", "socks5://5.6.7.8:1080"],
        source_ips=["2001:db8::1"],
        ipv6_subnet="2001:db8:abcd::/64",
    )
    # Proxy pool returned (whitespace entry dropped) and no source adapter mounted.
    assert pool == ["http://1.2.3.4:8080", "socks5://5.6.7.8:1080"]
    assert not isinstance(
        session.get_adapter("https://api.mangadex.org"),
        RotatingSourceAddressAdapter,
    )


def test_apply_rotation_mounts_source_adapter():
    session = requests.Session()
    pool = apply_ip_rotation(
        session,
        source_ips=["2001:db8::1", "2001:db8::2"],
    )
    assert pool == []
    for scheme in ("https://api.mangadex.org", "http://api.mangadex.org"):
        adapter = session.get_adapter(scheme)
        assert isinstance(adapter, RotatingSourceAddressAdapter)
        assert set(adapter._managers) == {"2001:db8::1", "2001:db8::2"}


def test_apply_rotation_generates_from_subnet():
    session = requests.Session()
    apply_ip_rotation(session, ipv6_subnet="2001:db8:abcd::/64", pool_size=8)
    adapter = session.get_adapter("https://api.mangadex.org")
    assert isinstance(adapter, RotatingSourceAddressAdapter)
    assert len(adapter._managers) == 8


def test_apply_rotation_disabled_by_default():
    session = requests.Session()
    default_adapter = session.get_adapter("https://api.mangadex.org")
    pool = apply_ip_rotation(session)
    assert pool == []
    # No adapter swap when nothing is configured.
    assert session.get_adapter("https://api.mangadex.org") is default_adapter


def test_global_proxy_rotation_injects_proxy(restore_session_request):
    captured = {}

    def fake_original(self, method, url, **kwargs):
        captured["proxies"] = kwargs.get("proxies")
        return "ok"

    # Simulate a stack where an in-process extension calls requests.get.
    _sessions.Session.request = fake_original
    assert install_global_proxy_rotation(["http://1.2.3.4:8080"]) is True

    import requests

    result = requests.Session().request("GET", "https://example.test/x")
    assert result == "ok"
    assert captured["proxies"] == {
        "http": "http://1.2.3.4:8080",
        "https": "http://1.2.3.4:8080",
    }


def test_global_proxy_rotation_respects_explicit_proxies(restore_session_request):
    captured = {}

    def fake_original(self, method, url, **kwargs):
        captured["proxies"] = kwargs.get("proxies")
        return "ok"

    _sessions.Session.request = fake_original
    install_global_proxy_rotation(["http://1.2.3.4:8080"])

    import requests

    explicit = {"http": "http://9.9.9.9:3128", "https": "http://9.9.9.9:3128"}
    requests.Session().request("GET", "https://example.test/x", proxies=explicit)
    assert captured["proxies"] == explicit  # caller's choice preserved


def test_global_proxy_rotation_respects_session_proxies(restore_session_request):
    captured = {}

    def fake_original(self, method, url, **kwargs):
        captured["proxies"] = kwargs.get("proxies")
        return "ok"

    _sessions.Session.request = fake_original
    install_global_proxy_rotation(["http://1.2.3.4:8080"])

    import requests

    s = requests.Session()
    s.proxies = {"https": "http://7.7.7.7:8080"}
    s.request("GET", "https://example.test/x")
    # Session-level proxies set → we don't override (leave requests to merge).
    assert captured["proxies"] is None


def test_global_proxy_rotation_skips_excluded_host(restore_session_request):
    captured = {}

    def fake_original(self, method, url, **kwargs):
        captured["proxies"] = kwargs.get("proxies")
        return "ok"

    _sessions.Session.request = fake_original
    install_global_proxy_rotation(
        ["http://1.2.3.4:8080"], no_proxy_hosts=["db.example.net"]
    )

    import requests

    # Excluded host (and its subdomains) go direct...
    requests.Session().request("GET", "https://db.example.net:27017/x")
    assert captured["proxies"] is None
    requests.Session().request("GET", "https://shard0.db.example.net/x")
    assert captured["proxies"] is None
    # ...but everything else is still proxied.
    requests.Session().request("GET", "https://api.mangadex.org/x")
    assert captured["proxies"] == {
        "http": "http://1.2.3.4:8080",
        "https": "http://1.2.3.4:8080",
    }


def test_global_proxy_rotation_no_proxy_from_env(restore_session_request, monkeypatch):
    captured = {}

    def fake_original(self, method, url, **kwargs):
        captured["proxies"] = kwargs.get("proxies")
        return "ok"

    monkeypatch.setenv("NO_PROXY", "internal.example")
    _sessions.Session.request = fake_original
    install_global_proxy_rotation(["http://1.2.3.4:8080"])

    import requests

    requests.Session().request("GET", "https://internal.example/x")
    assert captured["proxies"] is None


def test_global_proxy_rotation_empty_pool_is_noop(restore_session_request):
    before = _sessions.Session.request
    assert install_global_proxy_rotation([]) is False
    assert _sessions.Session.request is before


def test_global_proxy_rotation_idempotent(restore_session_request):
    install_global_proxy_rotation(["http://1.2.3.4:8080"])
    patched = _sessions.Session.request
    # Second install doesn't stack another wrapper.
    assert install_global_proxy_rotation(["http://1.2.3.4:8080"]) is True
    assert _sessions.Session.request is patched


def test_normalise_no_proxy_dedupes_and_lowercases(monkeypatch):
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.delenv("no_proxy", raising=False)
    assert _normalise_no_proxy([".Example.com", "example.com", "DB, cache"]) == [
        "example.com",
        "db",
        "cache",
    ]


def test_host_excluded_matches_exact_and_suffix():
    no_proxy = ["example.com", "db.internal"]
    assert _host_excluded("https://example.com/x", no_proxy)
    assert _host_excluded("https://api.example.com/x", no_proxy)  # subdomain
    assert _host_excluded("mongodb://db.internal:27017", no_proxy)
    assert not _host_excluded("https://notexample.com/x", no_proxy)
    assert not _host_excluded("https://other.net/x", no_proxy)
    assert _host_excluded("https://anything/x", ["*"])  # wildcard disables all


@pytest.mark.parametrize(
    "uri, expected",
    [
        ("mongodb://localhost:27017", ["localhost"]),
        ("mongodb://user:pass@db.example.net:27017/mydb", ["db.example.net"]),
        (
            "mongodb://u:p@h1:27017,h2:27018,h3:27019/db?replicaSet=rs0",
            ["h1", "h2", "h3"],
        ),
        ("mongodb+srv://user:pass@cluster0.abcd.mongodb.net/db", ["cluster0.abcd.mongodb.net"]),
        ("mongodb://[::1]:27017/db", ["::1"]),
        ("", []),
    ],
)
def test_mongo_hosts_parsing(uri, expected):
    assert _mongo_hosts(uri) == expected


def test_aiohttp_rotation_injects_socks_connector(restore_aiohttp_init):
    import asyncio

    from aiohttp_socks import ProxyConnector, ProxyType

    aiohttp = restore_aiohttp_init
    assert (
        install_global_aiohttp_proxy_rotation(["socks5://user:pass@1.2.3.4:1080"])
        is True
    )

    async def check():
        session = aiohttp.ClientSession()
        conn = session.connector
        assert isinstance(conn, ProxyConnector)
        assert conn._proxy_host == "1.2.3.4"
        assert conn._proxy_port == 1080
        assert conn._proxy_type == ProxyType.SOCKS5
        await session.close()

    asyncio.run(check())


def test_aiohttp_rotation_respects_explicit_connector(restore_aiohttp_init):
    import asyncio

    aiohttp = restore_aiohttp_init
    install_global_aiohttp_proxy_rotation(["socks5://1.2.3.4:1080"])

    async def check():
        own = aiohttp.TCPConnector()
        session = aiohttp.ClientSession(connector=own)
        assert session.connector is own  # caller's connector preserved
        await session.close()

    asyncio.run(check())


def test_aiohttp_rotation_empty_pool_is_noop(restore_aiohttp_init):
    aiohttp = restore_aiohttp_init
    before = aiohttp.ClientSession.__init__
    assert install_global_aiohttp_proxy_rotation([]) is False
    assert aiohttp.ClientSession.__init__ is before


def test_aiohttp_rotation_idempotent(restore_aiohttp_init):
    aiohttp = restore_aiohttp_init
    install_global_aiohttp_proxy_rotation(["socks5://1.2.3.4:1080"])
    patched = aiohttp.ClientSession.__init__
    assert install_global_aiohttp_proxy_rotation(["socks5://1.2.3.4:1080"]) is True
    assert aiohttp.ClientSession.__init__ is patched


def test_apply_rotation_bad_subnet_is_non_fatal():
    session = requests.Session()
    # Unparseable subnet: logged and skipped, no adapter mounted, no raise.
    pool = apply_ip_rotation(session, ipv6_subnet="not-a-subnet")
    assert pool == []
    assert not isinstance(
        session.get_adapter("https://api.mangadex.org"),
        RotatingSourceAddressAdapter,
    )
