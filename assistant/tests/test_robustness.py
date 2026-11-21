"""What happens when things around the agent break: no model, slow model, health reporting."""
from __future__ import annotations

import asyncio
from dataclasses import replace

from fastapi.testclient import TestClient

from app.api import create_app
from app.core.agent import DOWN_MESSAGE
from app.core.llm import LLMUnavailable
from tests.conftest import FakeLLM, sample_request


class DownLLM(FakeLLM):
    async def complete_json(self, **kw):
        raise LLMUnavailable("[router] LLM call failed: connection refused (OLLAMA_BASE_URL=http://nowhere:11434)")


class SlowLLM(FakeLLM):
    async def complete_json(self, **kw):
        await asyncio.sleep(5)
        return {}


def test_model_down_is_reported_not_crashed(settings):
    client = TestClient(create_app(settings, DownLLM()))
    r = client.post("/control", json=sample_request("hi").model_dump())
    body = r.json()
    assert r.status_code == 200 and body["status"] == "error" and body["message"] == DOWN_MESSAGE
    assert body["data"]["llm_unavailable"] is True and "OLLAMA_BASE_URL" in body["data"]["error"]


def test_a_stuck_model_times_out(settings):
    client = TestClient(create_app(replace(settings, turn_timeout_s=0.3), SlowLLM()))
    r = client.post("/control", json=sample_request("hi").model_dump())
    assert r.json()["status"] == "error" and r.json()["data"]["timeout"] is True


def test_stream_ends_with_final_when_model_down(settings):
    client = TestClient(create_app(settings, DownLLM()))
    with client.stream("POST", "/control/stream", json=sample_request("hi").model_dump()) as r:
        text = "".join(r.iter_text())
    assert "event: final" in text and "llm_unavailable" in text


def test_health_is_fast_and_deep_check_reports_the_model(settings):
    class Checked(FakeLLM):
        async def check(self):
            return {"reachable": False, "model_present": False, "error": "connection refused"}

    client = TestClient(create_app(settings, Checked()))
    assert client.get("/health").json()["status"] == "ok"
    deep = client.get("/health", params={"deep": "true"}).json()
    assert deep["llm"]["reachable"] is False and deep["llm"]["url"] == settings.ollama_base_url and deep["ready"] is False
    assert client.get("/ready").status_code == 503


def test_twin_base_follows_the_device_api(settings):
    s = replace(settings, st_api_base_url="http://localhost:3000/api/st/v1/devices", twin_api_base_url="")
    assert s.twin_base == "http://localhost:3000/api/st/v1/twin"
    assert replace(s, twin_api_base_url="http://x/twin/").twin_base == "http://x/twin"
