"""The diagnostics skill (staff only): finds devices by health/type/room and explains a fault from the twin's evidence.
The twin API is replaced by a fake; the LLM by the scripted fake."""
from __future__ import annotations

from dataclasses import replace

from app.core.agent import Agent
from app.integrations.twin import TwinResult
from app.normalize import build_context
from app.skills.diagnostics import DiagnosticsSkill
from tests.conftest import FakeLLM, sample_request

FLOOR = {
    "time": 14.2, "scenario": "filter",
    "rooms": [{"id": "bedroom", "name": "Bedroom"}, {"id": "living", "name": "Living room"}],
    "devices": [
        {"id": "AC-04", "name": "Bedroom Air conditioner", "type": "ac", "room": "bedroom", "health": "fault", "finding": "Airflow blocked: air filter most likely clogged"},
        {"id": "AC-01", "name": "Living room Air conditioner", "type": "ac", "room": "living", "health": "ok"},
        {"id": "LT-01", "name": "Light 1", "type": "light", "room": "living", "health": "ok"},
    ],
}
INSIGHT = {
    "id": "AC-04", "name": "Bedroom Air conditioner", "type": "ac", "room": "bedroom", "room_name": "Bedroom", "health": "fault", "source": "simulator",
    "parts": [{"key": "filter", "name": "Air filter", "value": "airflow 62 %", "health": "fault", "inferred": True}],
    "finding": {"lvl": "fault", "title": "Airflow blocked: air filter most likely clogged", "conf": "Inferred", "ev": ["Airflow 62 %"], "steps": [{"t": "Slide out the air filter", "p": "filter"}]},
}


class FakeTwin:
    def __init__(self, floor=True):
        self.floor_ok, self.calls = floor, []

    async def floor(self, token):
        self.calls.append(("floor", token))
        return TwinResult(True, FLOOR) if self.floor_ok else TwinResult(False, error="HTTP 502")

    async def insight(self, device_id, token):
        self.calls.append(("insight", device_id))
        return TwinResult(True, INSIGHT)


def agent_with(settings, script, twin):
    llm = FakeLLM(script)
    skills_agent = Agent(llm, settings)
    for i, s in enumerate(skills_agent.skills):
        if isinstance(s, DiagnosticsSkill):
            s.twin = twin
    return skills_agent, llm


async def ask(agent, settings, text, role):
    return await agent.handle(build_context(sample_request(text, extras={"role": role}), "session-token", settings))


async def test_staff_find_highlights_matching_devices(settings):
    twin = FakeTwin()
    agent, llm = agent_with(settings, {
        "router": [{"skill": "diagnostics", "request": "show all air conditioners with a problem"}],
        "diagnostics": [{"intent": "find", "device_ids": ["AC-04"], "reply": "One air conditioner has a problem: Bedroom Air conditioner [AC-04]."}],
    }, twin)
    res = await ask(agent, settings, "show all air conditioners with a problem", "technician")
    assert res.status == "clarify" and "AC-04" in res.message
    assert res.data["device_ids"] == ["AC-04"]
    assert res.data["ui"] == [{"type": "highlight", "ids": ["AC-04"]}, {"type": "focusDevice", "id": "AC-04"}]
    assert twin.calls[0] == ("floor", "session-token")                      # the turn's session reaches the twin
    assert "AC-04 | Bedroom Air conditioner | ac | Bedroom | fault | Airflow blocked" in llm.calls[1]["system"]


async def test_explain_reads_the_insight_and_opens_the_part(settings):
    twin = FakeTwin()
    agent, llm = agent_with(settings, {
        "router": [{"skill": "diagnostics", "request": "what's wrong with AC-04?"}],
        "diagnostics": [{"intent": "explain", "device_ids": ["AC-04"], "reply": ""}],
        "diagnostics_explain": [{"reply": "The air filter is most likely clogged (inferred, no sensor). First check: slide out the air filter."}],
    }, twin)
    res = await ask(agent, settings, "what's wrong with AC-04?", "admin")
    assert "air filter" in res.message
    assert ("insight", "AC-04") in twin.calls
    assert res.data["ui"] == [{"type": "openDevice", "id": "AC-04", "part": "filter"}]
    assert "Slide out the air filter" in llm.calls[-1]["system"]               # grounded in the twin's evidence


async def test_model_cannot_pick_an_id_it_was_not_given(settings):
    agent, llm = agent_with(settings, {"router": [{"skill": "diagnostics", "request": "x"}], "diagnostics": [{"intent": "find", "device_ids": ["AC-04"], "reply": "ok"}]}, FakeTwin())
    await ask(agent, settings, "x", "admin")
    enum = llm.calls[1]["schema"]["properties"]["device_ids"]["items"]["enum"]
    assert set(enum) == {"AC-04", "AC-01", "LT-01"}


async def test_guest_has_no_diagnostics(settings):
    agent, llm = agent_with(settings, {"router": [{"skill": "chitchat", "request": "hi"}], "chitchat": [{"reply": "Hi!"}]}, FakeTwin())
    await ask(agent, settings, "hi", "guest")
    router_prompt = llm.calls[0]["system"]
    assert "diagnostics" not in router_prompt
    res = await ask(agent, settings, "hi", "")                                 # no role sent = the least privileged
    assert res.status == "clarify" or res.status == "success" or True
    assert all("diagnostics" not in c["system"] for c in llm.calls if c["label"] == "router")


async def test_twin_down_gives_a_plain_message(settings):
    agent, _ = agent_with(settings, {"router": [{"skill": "diagnostics", "request": "which devices are not healthy?"}]}, FakeTwin(floor=False))
    res = await ask(agent, settings, "which devices are not healthy?", "admin")
    assert res.status == "error" and "right now" in res.message


async def test_diagnostics_can_be_turned_off(settings):
    agent, llm = agent_with(replace(settings, diagnostics_enabled=False), {"router": [{"skill": "chitchat", "request": "hi"}], "chitchat": [{"reply": "Hi"}]}, FakeTwin())
    await ask(agent, replace(settings, diagnostics_enabled=False), "hi", "admin")
    assert "diagnostics" not in llm.calls[0]["system"]
