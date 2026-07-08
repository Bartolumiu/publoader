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
    apply_ip_rotation,
    generate_ipv6_pool,
    install_global_proxy_rotation,
)


@pytest.fixture
def restore_session_request():
    """Undo the global Session.request monkeypatch after a test."""
    original = _sessions.Session.request
    yield
    _sessions.Session.request = original


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


def test_apply_rotation_bad_subnet_is_non_fatal():
    session = requests.Session()
    # Unparseable subnet: logged and skipped, no adapter mounted, no raise.
    pool = apply_ip_rotation(session, ipv6_subnet="not-a-subnet")
    assert pool == []
    assert not isinstance(
        session.get_adapter("https://api.mangadex.org"),
        RotatingSourceAddressAdapter,
    )
