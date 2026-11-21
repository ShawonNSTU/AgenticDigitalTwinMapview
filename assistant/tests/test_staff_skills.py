"""Staff skills (scene, building, checkin, maintenance) and routines, with a fake twin and the scripted LLM."""
from __future__ import annotations

from app.core.agent import Agent
from app.integrations.twin import TwinResult
from app.normalize import build_context
from tests.conftest import FakeLLM, sample_request
from tests.test_diagnostics import FLOOR


class OpsTwin:
    """Answers floor + ops from tables; records every op call."""
    def __init__(self, ops):
        self.ops, self.calls = ops, []

    async def floor(self, token):
        return TwinResult(True, FLOOR)

    async def insight(self, device_id, token):
        return TwinResult(False, error="n/a")

    async def op(self, name, payload, token):
        self.calls.append((name, payload, token))
        v = self.ops.get(name)
        v = v(payload) if callable(v) else v
        return TwinResult(True, v) if v is not None else TwinResult(False, error="unknown op")


def build(settings, script, twin):
    llm = FakeLLM(script)
    agent = Agent(llm, settings)
    for s in agent.skills:
        if hasattr(s, "twin"):
            s.twin = twin
    return agent, llm


async def ask(agent, settings, text, role="admin"):
    return await agent.handle(build_context(sample_request(text, extras={"role": role}), "tok", settings))


LAYOUT = {"title": "4th floor", "has_floor_plan_image": True, "floor_loaded": True, "room_count": 2, "device_count": 3, "entrances": ["Lift"],
          "rooms": [{"id": "bedroom", "name": "Bedroom", "devices": 1, "types": {"Air conditioner": 1}}, {"id": "living", "name": "Living room", "devices": 2, "types": {"Smart light": 1, "Air conditioner": 1}}]}


async def test_scene_open_part_and_layer_and_time(settings):
    twin = OpsTwin({"sim": {"time": 14.5, "scenario": "normal"}})
    agent, llm = build(settings, {"router": [{"skill": "scene", "request": "a"}, {"skill": "scene", "request": "b"}, {"skill": "scene", "request": "c"}],
        "scene": [{"action": "open", "device_ids": ["AC-04"], "part": "filter", "layer": "", "on": True, "scenario": "", "time": 0},
                  {"action": "layer", "device_ids": [], "part": "", "layer": "piping", "on": False, "scenario": "", "time": 0},
                  {"action": "time", "device_ids": [], "part": "", "layer": "", "on": True, "scenario": "", "time": 14.5}]}, twin)
    r = await ask(agent, settings, "a")
    assert r.data["ui"] == [{"type": "openDevice", "id": "AC-04", "part": "filter"}]
    r = await ask(agent, settings, "b")
    assert r.data["ui"] == [{"type": "setLayer", "layer": "piping", "on": False}]
    r = await ask(agent, settings, "c")
    assert r.message == "The simulated time is 14:30." and twin.calls[-1][:2] == ("sim", {"time": 14.5})


async def test_building_answers_from_the_live_layout(settings):
    twin = OpsTwin({"layout": LAYOUT})
    agent, llm = build(settings, {"router": [{"skill": "building", "request": "rooms?"}], "building": [{"reply": "Two rooms."}]}, twin)
    r = await ask(agent, settings, "rooms?", "technician")
    assert r.message == "Two rooms." and "Living room | 2 | 1 Smart light, 1 Air conditioner" in llm.calls[-1]["system"]


async def test_checkin_creates_pass_with_link_and_pin(settings):
    twin = OpsTwin({"layout": LAYOUT, "passes": {"passes": []},
                    "pass_create": lambda p: {"token": "abc", "path": "/guest/abc", "room": p["room"], "room_name": "Living room", "pin": "123456", "expires_at": 1_800_000_000_000, "label": p["label"]}})
    agent, _ = build(settings, {"router": [{"skill": "checkin", "request": "x"}], "checkin": [{"action": "create", "room": "living", "hours": 48, "label": "Rahim", "verify": True, "pass": ""}]}, twin)
    r = await ask(agent, settings, "x")
    assert "http://localhost:3000/guest/abc" in r.message and "PIN: 123456" in r.message and "Rahim" in r.message
    assert twin.calls[-1][:2] == ("pass_create", {"room": "living", "hours": 48, "label": "Rahim", "verify": True})


async def test_checkin_needs_a_room_and_revokes_by_number(settings):
    passes = {"passes": [{"token": "tok1", "room": "living", "room_name": "Living room", "label": "Rahim", "expires_at": 1_800_000_000_000}]}
    twin = OpsTwin({"layout": LAYOUT, "passes": passes, "pass_revoke": {"ok": True}})
    agent, _ = build(settings, {"router": [{"skill": "checkin", "request": "x"}, {"skill": "checkin", "request": "y"}],
        "checkin": [{"action": "create", "room": "", "hours": 24, "label": "", "verify": True, "pass": ""}, {"action": "revoke", "room": "", "hours": 24, "label": "", "verify": True, "pass": "1"}]}, twin)
    assert (await ask(agent, settings, "x")).message == "Which room is the guest checking into?"
    r = await ask(agent, settings, "y")
    assert "Checked out Rahim" in r.message and twin.calls[-1] == ("pass_revoke", {"token": "tok1"}, "tok")


ALERTS = {"alerts": [{"device_id": "AC-04", "name": "Bedroom Air conditioner", "room": "Bedroom", "level": "fault", "title": "Airflow blocked", "minutes": 3, "status": "new", "assignee": "HVAC technician", "first_step": "Slide out the filter", "simulated_fault": True}]}


async def test_maintenance_fix_clears_the_fault_and_resolve_records_it(settings):
    twin = OpsTwin({"alerts": ALERTS, "clear_fault": {"ok": True}, "alert_update": {"ok": True}})
    agent, _ = build(settings, {"router": [{"skill": "maintenance", "request": "x"}, {"skill": "maintenance", "request": "y"}],
        "maintenance": [{"action": "fix", "device_id": "AC-04", "cause": "", "action_taken": ""},
                        {"action": "resolve", "device_id": "AC-04", "cause": "clogged filter", "action_taken": "washed the filter"}]}, twin)
    r = await ask(agent, settings, "x", "technician")
    assert r.status == "success" and twin.calls[-1][0] == "clear_fault" and r.data["ui"] == [{"type": "focusDevice", "id": "AC-04"}]
    r = await ask(agent, settings, "y", "technician")
    name, payload, _ = twin.calls[-1]
    assert name == "alert_update" and payload["status"] == "resolved" and payload["cause"] == "clogged filter" and "washed the filter" in r.message


async def test_maintenance_with_no_alerts(settings):
    agent, llm = build(settings, {"router": [{"skill": "maintenance", "request": "x"}]}, OpsTwin({"alerts": {"alerts": []}}))
    r = await ask(agent, settings, "x")
    assert "no open alerts" in r.message and llm.labels() == ["router"]          # no model call needed


ROUTINES = {"routines": [{"id": "movie", "name": "Movie night", "about": "Dim lights"}, {"id": "sleep", "name": "Good night", "about": "Everything off"}],
            "rooms": [{"id": "living", "name": "Living room"}]}


async def test_routine_runs_in_a_room_and_reports_failures(settings):
    run = {"routine": "Movie night", "room": "Living room", "results": [{"device_id": "LT-01", "name": "Light 1", "steps": ["setLevel"], "ok": True}, {"device_id": "TV-01", "name": "TV", "steps": ["power"], "ok": False, "error": "offline"}]}
    twin = OpsTwin({"routines": ROUTINES, "routine_run": run})
    agent, _ = build(settings, {"router": [{"skill": "routines", "request": "x"}], "routines": [{"action": "run", "routine": "movie", "room": "living"}]}, twin)
    r = await ask(agent, settings, "x")
    assert r.status == "success" and "Light 1" in r.message and "TV (offline)" in r.message
    assert [x["status"] for x in r.data["results"]] == ["success", "error"]


async def test_staff_routine_asks_for_the_room_and_guest_does_not(settings):
    twin = OpsTwin({"routines": ROUTINES, "routine_run": {"routine": "Good night", "room": "Room", "results": [{"device_id": "LT-01", "name": "Light 1", "steps": ["power"], "ok": True}]}})
    agent, llm = build(settings, {"router": [{"skill": "routines", "request": "x"}, {"skill": "routines", "request": "y"}],
                                  "routines": [{"action": "run", "routine": "sleep", "room": ""}, {"action": "run", "routine": "sleep"}]}, twin)
    assert (await ask(agent, settings, "x")).message == "Which room should I run Good night in?"
    guest_twin = OpsTwin({"routines": {"routines": ROUTINES["routines"]}, "routine_run": {"routine": "Good night", "room": "Room", "results": [{"device_id": "LT-01", "name": "Light 1", "steps": ["power"], "ok": True}]}})
    for s in agent.skills:
        if hasattr(s, "twin"):
            s.twin = guest_twin
    r = await ask(agent, settings, "y", "guest")
    assert r.status == "success" and guest_twin.calls[-1][1] == {"routine": "sleep", "room": ""}
    assert "room" not in llm.calls[-1]["schema"]["properties"]                    # a guest's room is not asked


async def test_staff_skills_are_hidden_from_guests(settings):
    agent, llm = build(settings, {"router": [{"skill": "chitchat", "request": "hi"}], "chitchat": [{"reply": "Hi"}]}, OpsTwin({}))
    await ask(agent, settings, "hi", "guest")
    router = llm.calls[0]["system"]
    assert all(n not in router for n in ("- scene", "- building", "- checkin", "- maintenance", "- diagnostics")) and "- routines" in router
