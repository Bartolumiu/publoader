"""Tests for HTTPModel._request's connection-error retry behaviour.

A RequestException (DNS failure, connection reset, IP block) produces no
response, so the retry counters that live on the response path never ran —
`except: continue` used to spin the `while retry > 0` loop forever, hammering
the API with zero backoff. These tests pin the fixed behaviour: bounded
attempts, backoff sleeps between them, and a RequestError once exhausted.
No real network traffic is sent.
"""
import pytest
import requests

from publoader.http import model as model_module
from publoader.http.model import HTTPModel
from publoader.http.properties import RequestError


@pytest.fixture
def http_model():
    return HTTPModel()


def test_persistent_connection_error_raises_after_bounded_attempts(
    http_model, monkeypatch
):
    attempts = []
    sleeps = []

    def failing_request(*args, **kwargs):
        attempts.append(1)
        raise requests.ConnectionError(
            "HTTPSConnectionPool(host='api.mangadex.org', port=443): "
            "Max retries exceeded with url: /manga"
        )

    monkeypatch.setattr(http_model.session, "request", failing_request)
    monkeypatch.setattr(model_module.time, "sleep", lambda s: sleeps.append(s))

    with pytest.raises(RequestError):
        http_model._request("GET", "https://api.mangadex.org/manga")

    assert len(attempts) == http_model.upload_retry_total
    # Backoff between attempts, but not after the last one.
    assert len(sleeps) == http_model.upload_retry_total - 1
    assert all(s > 0 for s in sleeps)


def test_connection_error_then_success_returns_response(http_model, monkeypatch):
    calls = {"n": 0}

    class FakeResponse:
        status_code = 200
        headers = {"x-ratelimit-retry-after": "0", "x-ratelimit-remaining": "10"}
        url = "https://api.mangadex.org/manga"

        def json(self):
            return {"result": "ok", "data": []}

    def flaky_request(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise requests.ConnectionError("first attempt fails")
        return FakeResponse()

    monkeypatch.setattr(http_model.session, "request", flaky_request)
    monkeypatch.setattr(model_module.time, "sleep", lambda s: None)

    response = http_model._request(
        "GET", "https://api.mangadex.org/manga", sleep=False
    )

    assert calls["n"] == 2
    assert response.status_code == 200
