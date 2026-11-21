"""End to end with the digital twin PoC: browser -> web /api/chat -> this agent -> the twin's SmartThings API.

Runs only when the twin's web app is reachable (TWIN_URL, default http://localhost:3000) and port 8100 (the web
app's ST_AGENT_URL) is free. The agent runs here with the scripted fake LLM; everything else is real: the web app
builds the device list from the twin, the agent calls the twin's /api/st/v1/devices with the turn's session
token, and the twin runs the commands (on the simulator, or the real device when linked).

    TWIN_URL=http://localhost:3000 .venv/bin/python -m pytest -q tests/test_twin_integration.py
"""
from __future__ import annotations

import json
import os
import socket
import threading
import time
from dataclasses import replace

import httpx
import pytest
import uvicorn

from app.api import create_app
from app.config import Settings
from tests.conftest import FakeLLM

TWIN = os.getenv("TWIN_URL", "http://localhost:3000").rstrip("/")
PORT = 8100


def _twin_up() -> bool:
    try:
        return httpx.get(f"{TWIN}/api/floor", timeout=5).status_code == 200
    except httpx.HTTPError:
        return False


def _port_free() -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", PORT)) != 0


pytestmark = pytest.mark.skipif(not (_twin_up() and _port_free()), reason="twin web app not running (or port 8100 busy)")


def route(skill, request):
    return {"skill": skill, "request": request}


def act(*pairs, change="set"):
    return {"actions": [{"action": a, "change": change, "value": v} for a, v in zip(pairs[::2], pairs[1::2])]}


@pytest.fixture(scope="module")
def llm():
    fake = FakeLLM({})
    settings = replace(Settings(), st_api_base_url=f"{TWIN}/api/st/v1/devices", st_dry_run=False, st_default_token="")
    server = uvicorn.Server(uvicorn.Config(create_app(settings, fake), host="127.0.0.1", port=PORT, log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    for _ in range(50):
        if not _port_free():
            break
        time.sleep(0.1)
    yield fake
    server.should_exit = True
    t.join(5)


def chat(path: str, text: str, **body) -> list[tuple[str, dict]]:
    """One chat turn through the web app; the events it streams back."""
    events = []
    with httpx.stream("POST", f"{TWIN}{path}", json={"messages": [{"role": "user", "content": text}], **body}, timeout=60) as r:
        buf = ""
        for chunk in r.iter_text():
            buf += chunk
            while "\n\n" in buf:
                block, buf = buf.split("\n\n", 1)
                ev = next((l[7:] for l in block.splitlines() if l.startswith("event: ")), "")
                data = next((l[6:] for l in block.splitlines() if l.startswith("data: ")), "{}")
                events.append((ev, json.loads(data)))
    return events


def zone_device(name: str) -> dict:
    floor = httpx.get(f"{TWIN}/api/floor", timeout=10).json()
    return next(d for d in floor["devices"] if d["room"] == "smartthings-experience-zone" and d["name"].split(" · ")[0] == name)


def readings(dev_id: str) -> dict:
    return httpx.get(f"{TWIN}/api/devices/{dev_id}", timeout=10).json()["readings"]


def test_health_seen_by_twin(llm):
    h = httpx.get(f"{TWIN}/api/chat", timeout=10).json()
    assert h["ok"] is True and "device_control" in h["skills"]


def test_control_goes_through_the_twin(llm):
    d = zone_device("Light 4")
    llm.script = {"router": [route("device_control", "turn on Light 4 and dim it to 35%")],
                  "device_plan": [{"result": "OK", "steps": [{"devices": ["Light 4"], "request": "turn on and dim to 35%"}], "options": []}],
                  "action_select": [act("switch.on", "", "switchLevel.setLevel", "35")]}
    events = chat("/api/chat", "turn on Light 4 and dim it to 35%")
    kinds = [e for e, _ in events]
    assert "tool" in kinds and kinds[-1] == "done", events                       # progress streamed, then done
    text = next(d["text"] for e, d in events if e == "text")
    assert text.startswith("Done!") and "35%" in text, text
    hi = next(d for e, d in events if e == "ui_action" and d["type"] == "highlight")
    assert hi["ids"] == [d["id"]]                                                   # the 3D view shows the device
    assert ("ui_action", {"type": "focusDevice", "id": d["id"]}) in events           # and turns to it
    assert not any(e == "select" for e, _ in events)                              # the chat stays open
    assert readings(d["id"])["lv"] == 35                                            # the twin changed


def test_device_list_comes_from_the_twin(llm):
    sent = llm.calls[-1]["system"] if llm.calls else ""
    llm.script = {"router": [route("device_info", "which devices are there?")], "device_info": [{"reply": "ok"}]}
    chat("/api/chat", "which devices are there?", room="smartthings-experience-zone")
    prompt = llm.calls[-1]["system"]
    for name in ("Light 1", "Desk Lamp", "Aqara Roller Shade Controller", "Blinds Switch", "TV Lamp", "Ceiling AC"):
        assert name in prompt, name
    assert "of dining" not in prompt                                                   # the dining shade is not in the room
    assert sent is not None


def test_shade_switches_its_motor_on_first(llm):
    shade, switch = zone_device("Aqara Roller Shade Controller"), zone_device("Blinds Switch")
    httpx.post(f"{TWIN}/api/devices/{switch['id']}/commands", json={"command": "power", "args": {"on": "false"}}, timeout=10)
    llm.script = {"router": [route("device_control", "set the Aqara Roller Shade Controller to 45%")],
                  "action_select": [act("windowShadeLevel.setShadeLevel", "45")]}
    events = chat("/api/chat", "set the Aqara Roller Shade Controller to 45%")
    assert any(e == "text" and d["text"].startswith("Done!") for e, d in events), events
    assert readings(shade["id"])["pos"] == 45
    assert readings(switch["id"])["on"] is True                                     # the zone's rule, kept


def test_status_answer_uses_the_twins_state(llm):
    d = zone_device("Light 4")
    httpx.post(f"{TWIN}/api/devices/{d['id']}/commands", json={"command": "setLevel", "args": {"percent": 62}}, timeout=10)
    time.sleep(0.3)
    llm.script = {"router": [route("device_status", "is Light 4 on?")],
                  "device_status": [lambda system, user: {"reply": next(l for l in system.splitlines() if "Light 4" in l)}]}
    events = chat("/api/chat", "is Light 4 on?")
    text = next(d["text"] for e, d in events if e == "text")
    assert "on" in text and "62" in text, text                                      # read from the twin's status


def test_relative_change_reads_current_value_first(llm):
    d = zone_device("Light 4")
    httpx.post(f"{TWIN}/api/devices/{d['id']}/commands", json={"command": "setLevel", "args": {"percent": 50}}, timeout=10)
    time.sleep(0.3)
    llm.script = {"router": [route("device_control", "make Light 4 brighter by 10%")],
                  "action_select": [act("switchLevel.setLevel", "10", change="increase")]}
    chat("/api/chat", "make Light 4 brighter by 10%")
    assert readings(d["id"])["lv"] == 60


def test_twin_api_needs_a_session():
    r = httpx.get(f"{TWIN}/api/st/v1/devices/LT-01/status", timeout=10)
    assert r.status_code == 401
    r = httpx.post(f"{TWIN}/api/st/v1/devices/LT-01/commands", json={"commands": []}, headers={"Authorization": "Bearer made-up"}, timeout=10)
    assert r.status_code == 401


def test_guest_agent_is_limited_by_the_pass(llm):
    # a pass for the zone that lets the guest control lights only
    p = httpx.post(f"{TWIN}/api/guest", json={"room": "smartthings-experience-zone", "verify": False, "controls": ["light"]}, timeout=10).json()
    path = f"/api/guest/{p['token']}/chat"
    llm.script = {"router": [route("device_info", "what can I control?")], "device_info": [{"reply": "ok"}]}
    chat(path, "what can I control?")
    prompt = llm.calls[-1]["system"]
    assert "Light 1" in prompt
    # devices the pass doesn't let the guest control are there to ask about, with nothing to run
    shade_line = next((l for l in prompt.splitlines() if "Aqara Roller Shade Controller" in l), "")
    assert "windowShade" not in shade_line and "shade position" not in shade_line.lower(), shade_line
    d = zone_device("Light 2")
    llm.script = {"router": [route("device_control", "set Light 2 to 25%")], "action_select": [act("switchLevel.setLevel", "25")]}
    events = chat(path, "set Light 2 to 25%")
    res = next(d for e, d in events if e == "result")["results"]
    assert res[0]["ok"] is True and res[0]["label"] == "Light 2"
    assert not any(e == "tool" for e, _ in events)                                  # guests see no internals
    assert readings(d["id"])["lv"] == 25


# ---- the whole building: real zone devices and simulated (generic) devices, one assistant ----

def gym_device(kind: str) -> dict:
    floor = httpx.get(f"{TWIN}/api/floor", timeout=10).json()
    found = [d for d in floor["devices"] if d["type"] == kind and d["room"] == "gym-room"]
    if not found:
        pytest.skip(f"no simulated {kind} in the gym room (add one with POST /api/devices)")
    return found[0]


def test_staff_assistant_controls_a_simulated_device_by_room_name(llm):
    ac = gym_device("ac")
    llm.script = {"router": [route("device_control", "set the Gym Room Air conditioner to 23 degrees")],
                  "action_select": [act("thermostatCoolingSetpoint.setCoolingSetpoint", "23")]}
    events = chat("/api/chat", "set the Gym Room Air conditioner to 23 degrees")
    text = next(d["text"] for e, d in events if e == "text")
    assert text.startswith("Done!") and "23" in text, events
    assert readings(ac["id"])["set"] == 23                                          # the simulator changed
    assert any(e == "ui_action" and d.get("type") == "highlight" and d["ids"] == [ac["id"]] for e, d in events)


def test_staff_assistant_reads_a_simulated_sensor(llm):
    leak = gym_device("leak")
    llm.script = {"router": [route("device_status", "is the Gym Room Water leak sensor wet?")],
                  "device_status": [lambda system, user: {"reply": next(l for l in system.splitlines() if "Water leak" in l)}]}
    events = chat("/api/chat", "is the Gym Room Water leak sensor wet?")
    text = next(d["text"] for e, d in events if e == "text")
    assert "dry" in text.lower() or "water leak" in text.lower(), text
    assert leak["id"]


def test_diagnostics_find_and_explain_through_the_twin(llm):
    ac = gym_device("ac")
    httpx.post(f"{TWIN}/api/sim", json={"scenario": "normal"}, timeout=10)
    llm.script = {"router": [route("diagnostics", "which devices are there in the gym room?")],
                  "diagnostics": [lambda system, user: {"intent": "find", "device_ids": [ac["id"]], "reply": f"Found {ac['id']}."}]}
    events = chat("/api/chat", "which devices are there in the gym room?")
    assert any(e == "ui_action" and d.get("type") == "highlight" and d["ids"] == [ac["id"]] for e, d in events), events
    assert ("ui_action", {"type": "focusDevice", "id": ac["id"]}) in events
    # explain: the twin's insight (parts, health, evidence) reaches the model
    llm.script = {"router": [route("diagnostics", f"what is wrong with {ac['id']}?")],
                  "diagnostics": [{"intent": "explain", "device_ids": [ac["id"]], "reply": ""}],
                  "diagnostics_explain": [lambda system, user: {"reply": "It is fine. " + system.splitlines()[2]}]}
    events = chat("/api/chat", f"what is wrong with {ac['id']}?")
    assert any(e == "ui_action" and d.get("type") == "openDevice" and d["id"] == ac["id"] for e, d in events), events
    assert any(e == "select" and d["id"] == ac["id"] for e, d in events)
    assert "Air filter" in llm.calls[-1]["system"] and "Health:" in llm.calls[-1]["system"]


def test_guest_gets_no_diagnostics_and_no_other_rooms(llm):
    p = httpx.post(f"{TWIN}/api/guest", json={"room": "smartthings-experience-zone", "verify": False, "controls": ["light"]}, timeout=10).json()
    llm.script = {"router": [route("device_info", "which devices are there?")], "device_info": [{"reply": "ok"}]}
    chat(f"/api/guest/{p['token']}/chat", "which devices are there?")
    prompt = llm.calls[-1]["system"]
    assert "Gym Room" not in prompt and "Water leak" not in prompt
    assert "diagnostics" not in llm.calls[-2]["system"]                              # not even offered to the router


def test_diagnostics_api_is_staff_only():
    p = httpx.post(f"{TWIN}/api/guest", json={"room": "smartthings-experience-zone", "verify": False, "controls": ["light"]}, timeout=10).json()
    assert p["token"]
    assert httpx.get(f"{TWIN}/api/st/v1/twin/floor", timeout=10).status_code == 401
    assert httpx.get(f"{TWIN}/api/st/v1/twin/floor", headers={"Authorization": "Bearer nope"}, timeout=10).status_code == 401
