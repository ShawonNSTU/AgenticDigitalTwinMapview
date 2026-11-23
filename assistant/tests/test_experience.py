"""The experience skill (comfort, energy, guest arrival, predictions, dispatch) with a fake twin and the scripted LLM."""
from __future__ import annotations

from tests.test_staff_skills import OpsTwin, ask, build

ZONE = {"room": "zone", "name": "Experience Zone", "score": 71, "grade": "good", "temp": 24.6, "target": 23, "hum": 55, "pm": 12, "lux": 300, "db": 41,
        "parts": {"thermal": "62/100 Slightly warm", "air": "100/100 Clean", "light": "100/100 Bright (estimated)", "sound": "82/100 Some noise (estimated)"},
        "eta_to_target_min": 3.5, "advice": ["Cool the room to 23 °C with Ceiling AC"]}
ENERGY = {"scope": "whole floor", "watts_now": 640.2, "kwh_today": 1.25, "cost_today": "0.19 USD", "co2_kg_today": 0.56,
          "avoided_by_automation": {"kwh": 0.12, "cost": 0.02, "co2Kg": 0.05}, "eco_rooms": [{"name": "Room 401", "reason": "guest stepped out"}],
          "top_devices": [{"id": "AC-01", "name": "Ceiling AC", "watts": 330, "source": "model"}], "rooms": [{"name": "Experience Zone", "w": 640}]}
JOURNEY = {"state": "preparing", "roomName": "Experience Zone", "prefs": {"temp": 22.5, "scene": "warm", "curtain": 50},
           "comfort": {"temp": 23.9, "target": 22.5, "score": 88, "etaToTargetMin": 2.0},
           "steps": [{"status": "done", "real": True}, {"status": "done", "real": True}, {"status": "running", "real": False}]}
PRED = {"device_id": "AP-01", "name": "Air purifier", "room": "Experience Zone", "part": "BLDC fan motor", "title": "BLDC fan motor will fail",
        "when": "4 min", "eta_min": 4, "confidence": 0.85, "basis": "degradation-model", "evidence": ["Wear at 30 %"], "action": "Check the fan"}


def staff_twin():
    return OpsTwin({
        "comfort": {"rooms": [ZONE]},
        "comfort_apply": {"room": "Experience Zone", "score_before": 71, "score_after": 78, "advice_applied": ["Cool the room to 23 °C with Ceiling AC"],
                          "results": [{"device_id": "AC-01", "name": "Ceiling AC", "command": "setTemperature", "args": {"celsius": 23}, "ok": True}]},
        "energy": ENERGY,
        "journey": {"journeys": [{"token": "t1", "guest": "Ayesha", "room": "Experience Zone", "state": "en_route", "eta_min": 12, "prefs": {}, "steps_done": 0, "steps": 0}], "housekeeping": []},
        "journey_action": lambda p: {"journey": {**JOURNEY, "guest": "Ayesha", "room": "zone", "leadMin": 5, "state": "departed" if p.get("action") == "checkout" else "preparing"}},
        "predictions": {"predictions": [PRED], "dispatches": []},
        "alerts": {"alerts": []},
        "dispatch_tech": {"ok": True, "dispatch": {"tech": {"name": "HVAC technician"}, "fromName": "Lift Lobby", "reason": "BLDC fan motor will fail"}},
    })


ROUTE = {"skill": "experience", "request": "x"}


def step(action, **kw):
    return {"action": action, "minutes": 0, "temp": 0, "scene": "", "curtain": -1, "room": "", "guest": "", "device_id": "", **kw}


async def test_comfort_status_explains_and_shows_the_field(settings):
    twin = staff_twin()
    agent, _ = build(settings, {"router": [ROUTE], "experience": [step("comfort_status", room="zone")]}, twin)
    r = await ask(agent, settings, "how comfortable is the zone?")
    assert "71/100" in r.message and "24.6 °C" in r.message and "Cool the room to 23" in r.message and "[[Make it comfortable]]" in r.message
    assert {"type": "setLayer", "layer": "comfort", "on": True} in r.data["ui"] and {"type": "selectRoom", "room": "zone"} in r.data["ui"]
    assert ("comfort", {"room": "zone"}) == twin.calls[-1][:2]


async def test_make_it_comfortable_applies_advice(settings):
    twin = staff_twin()
    agent, _ = build(settings, {"router": [ROUTE], "experience": [step("comfort_apply", room="zone")]}, twin)
    r = await ask(agent, settings, "make the zone comfortable")
    assert r.status == "success" and "71 to 78/100" in r.message
    assert ("comfort_apply", {"room": "zone"}) == twin.calls[-1][:2]


async def test_energy_reports_now_today_cost_and_savings(settings):
    agent, _ = build(settings, {"router": [ROUTE], "experience": [step("energy")]}, staff_twin())
    r = await ask(agent, settings, "how much energy did we use today?")
    assert "640 W" in r.message and "1.25 kWh" in r.message and "0.19 USD" in r.message and "0.120 kWh" in r.message and "Room 401" in r.message
    assert r.data["ui"] == [{"type": "setLayer", "layer": "energy", "on": True}]


async def test_staff_sets_eta_and_checks_out(settings):
    twin = staff_twin()
    agent, _ = build(settings, {"router": [ROUTE, ROUTE], "experience": [step("eta", guest="t1", minutes=20), step("checkout", guest="t1")]}, twin)
    r = await ask(agent, settings, "Ayesha arrives in 20 minutes")
    assert r.status == "success" and "20 min" in r.message
    assert twin.calls[-1][:2] == ("journey_action", {"token": "t1", "action": "eta", "minutes": 20})
    r = await ask(agent, settings, "check Ayesha out")
    assert "eco" in r.message and "housekeeping" in r.message and twin.calls[-1][1]["action"] == "checkout"


async def test_predictions_then_dispatch_draws_route(settings):
    twin = staff_twin()
    agent, _ = build(settings, {"router": [ROUTE, ROUTE], "experience": [step("predictions"), step("dispatch", device_id="AP-01")]}, twin)
    r = await ask(agent, settings, "what will fail next?", role="technician")
    assert "Air purifier" in r.message and "4 min" in r.message and "85 %" in r.message and "[[Send a technician to AP-01]]" in r.message
    r = await ask(agent, settings, "send a technician to AP-01", role="technician")
    assert r.status == "success" and "HVAC technician" in r.message and "Lift Lobby" in r.message
    assert r.data["ui"] == [{"type": "dispatchRoute", "id": "AP-01"}]


async def test_guest_on_my_way_and_status(settings):
    calls = []
    twin = OpsTwin({"journey": {"journey": JOURNEY}, "journey_action": lambda p: calls.append(p) or {"journey": JOURNEY}})
    agent, _ = build(settings, {"router": [ROUTE, ROUTE], "experience": [step("on_my_way", minutes=15), step("journey_status")]}, twin)
    r = await ask(agent, settings, "I'll be there in 15 minutes", role="guest")
    assert calls[-1] == {"action": "on_my_way", "minutes": 15} and "ready when you get there" in r.message and "being prepared" in r.message
    r = await ask(agent, settings, "is my room ready?", role="guest")
    assert "23.9 °C" in r.message and "2 of 3" in r.message and "real SmartThings" in r.message


async def test_guest_is_offered_only_guest_actions(settings):
    twin = OpsTwin({"energy": ENERGY})
    agent, llm = build(settings, {"router": [ROUTE], "experience": [step("energy")]}, twin)
    await ask(agent, settings, "how much power does my room use?", role="guest")
    enum = next(c for c in llm.calls if c["label"] == "experience")["schema"]["properties"]["action"]["enum"]
    assert "dispatch" not in enum and "checkout" not in enum and "predictions" not in enum and "on_my_way" in enum
    assert "room" not in next(c for c in llm.calls if c["label"] == "experience")["schema"]["properties"]   # a guest can't name another room
    assert twin.calls[-1][:2] == ("energy", {})


async def test_not_offered_without_the_twin_session(settings):
    from app.skills.experience import ExperienceSkill
    from app.core.context import TurnContext
    s = ExperienceSkill(None, settings)
    assert s.is_available(TurnContext(message="hi", history=[], devices=[], extras={"role": "guest"})) is True
    assert s.is_available(TurnContext(message="hi", history=[], devices=[], extras={})) is False


async def test_climate_vision_opens_the_3d_air_view(settings):
    agent, _ = build(settings, {"router": [ROUTE], "experience": [step("climate_vision")]}, staff_twin())
    r = await ask(agent, settings, "show me how the AC cools the zone")
    assert r.status == "success" and "Climate Vision" in r.message
    assert r.data["ui"] == [{"type": "climateVision", "on": True}]


async def test_climate_vision_smoke_test(settings):
    agent, _ = build(settings, {"router": [ROUTE], "experience": [step("climate_vision", room="zone")]}, staff_twin())
    r = await ask(agent, settings, "show the smoke spreading and the purifier cleaning it")
    assert r.data["ui"] == [{"type": "climateVision", "on": True, "room": "zone", "smoke": True}]
