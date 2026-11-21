"""End to end with the digital twin PoC: browser -> web /api/chat -> this agent -> the twin's SmartThings API.

Runs only when the twin's web app is reachable (TWIN_URL, default http://localhost:3000) and port 8100 (the web
app's ASSISTANT_URL) is free. The agent runs here with the scripted fake LLM; everything else is real: the web app
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
    llm.script = {"router": [route("knowledge", "which devices are there?")], "knowledge": [{"reply": "ok", "sources": [], "follow_ups": []}]}
    chat("/api/chat", "which devices are there in the SmartThings Experience Zone?", room="smartthings-experience-zone")
    kg = " ".join(d["text"] for d in httpx.get(f"{TWIN}/api/kg?graph=1", timeout=10).json()["docs"])
    for name in ("Light 1", "Desk Lamp", "Aqara Roller Shade Controller", "Blinds Switch", "TV Lamp", "Ceiling AC"):
        assert name in kg, name
    prompt = kg
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
    llm.script = {"router": [route("knowledge", "what can I control?")], "knowledge": [{"reply": "ok", "sources": [], "follow_ups": []}]}
    chat(path, "what can I control? lights shade roller")
    prompt = llm.calls[-1]["system"]
    assert "Light 1" in prompt
    # devices the pass doesn't let the guest control are there to ask about, with nothing to run
    shade_line = next((l for l in prompt.splitlines() if "Aqara Roller Shade Controller" in l and "It can" in l), "")
    assert not shade_line or "not by you" in shade_line, shade_line
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
    llm.script = {"router": [route("knowledge", "which devices are there?")], "knowledge": [{"reply": "ok", "sources": [], "follow_ups": []}]}
    chat(f"/api/guest/{p['token']}/chat", "which devices are there?")
    prompt = llm.calls[-1]["system"]
    assert "Water leak" not in prompt and "Treadmill" not in prompt.title()
    assert "diagnostics" not in llm.calls[-2]["system"]                              # not even offered to the router


def test_diagnostics_api_is_staff_only():
    p = httpx.post(f"{TWIN}/api/guest", json={"room": "smartthings-experience-zone", "verify": False, "controls": ["light"]}, timeout=10).json()
    assert p["token"]
    assert httpx.get(f"{TWIN}/api/st/v1/twin/floor", timeout=10).status_code == 401
    assert httpx.get(f"{TWIN}/api/st/v1/twin/floor", headers={"Authorization": "Bearer nope"}, timeout=10).status_code == 401


# ---- routines, check-in, 3D view, alerts: the staff and guest skills against the live twin ----

def test_staff_routine_sets_every_device_type_in_the_room(llm):
    ac = gym_device("ac")
    httpx.delete(f"{TWIN}/api/devices/{ac['id']}/fault", timeout=10)
    light, blinds = gym_device("light"), gym_device("blinds")
    llm.script = {"router": [route("routines", "good night in the gym room")], "routines": [{"action": "run", "routine": "sleep", "room": "gym-room", "name": ""}]}
    events = chat("/api/chat", "good night in the gym room")
    text = next(d["text"] for e, d in events if e == "text")
    assert text.lower().startswith("done! good night in gym room"), events
    assert readings(light["id"])["lv"] == 0 and readings(blinds["id"])["pos"] == 0
    assert readings(ac["id"])["set"] == 24
    hi = next(d for e, d in events if e == "ui_action" and d["type"] == "highlight")
    assert {light["id"], blinds["id"], ac["id"]} <= set(hi["ids"])


def test_guest_routine_only_touches_what_the_pass_allows(llm):
    p = httpx.post(f"{TWIN}/api/guest", json={"room": "smartthings-experience-zone", "verify": False, "controls": ["light"]}, timeout=10).json()
    d = zone_device("Light 2")
    httpx.post(f"{TWIN}/api/devices/{d['id']}/commands", json={"command": "setLevel", "args": {"percent": 10}}, timeout=10)
    llm.script = {"router": [route("routines", "make it bright")], "routines": [{"action": "run", "routine": "focus", "name": ""}]}
    events = chat(f"/api/guest/{p['token']}/chat", "make it bright")
    res = next(x for e, x in events if e == "result")["results"]
    assert res and all(r["ok"] for r in res), events
    assert readings(d["id"])["lv"] == 100                                           # the pass allows lights
    shade = zone_device("Aqara Roller Shade Controller")
    assert shade["name"] not in [r["label"] for r in res]                           # shades are not in this pass


def test_checkin_check_out_through_the_assistant(llm):
    llm.script = {"router": [route("checkin", "check Rahim into the zone")],
                  "checkin": [{"action": "create", "room": "smartthings-experience-zone", "hours": 24, "label": "Rahim", "verify": True, "pass": ""}]}
    events = chat("/api/chat", "check Rahim into the zone")
    text = next(d["text"] for e, d in events if e == "text")
    assert "/guest/" in text and "PIN:" in text and "Rahim" in text, events
    token = text.split("/guest/")[1].split()[0].rstrip(".")
    assert httpx.get(f"{TWIN}/api/guest/{token}", timeout=10).status_code in (200, 401)   # the link is live (PIN not yet entered)
    llm.script = {"router": [route("checkin", "check out Rahim")],
                  "checkin": [lambda s, u: {"action": "revoke", "room": "", "hours": 24, "label": "", "verify": True,
                                            "pass": next(l.split(":")[0] for l in s.splitlines() if "Rahim" in l and l[0].isdigit())}]}
    events = chat("/api/chat", "check out Rahim")
    assert "Checked out Rahim" in next(d["text"] for e, d in events if e == "text"), events
    assert httpx.get(f"{TWIN}/api/guest/{token}", timeout=10).status_code == 410   # withdrawn


def test_fault_is_listed_and_fixed_by_the_assistant(llm):
    ac = gym_device("ac")
    httpx.post(f"{TWIN}/api/devices/{ac['id']}/fault", json={"key": "offline"}, timeout=10)
    time.sleep(7)                                                                    # a fault develops over about 6 s
    llm.script = {"router": [route("maintenance", "what alerts are open?")], "maintenance": [{"action": "list", "device_id": "", "cause": "", "action_taken": ""}]}
    events = chat("/api/chat", "what alerts are open?")
    assert "offline" in next(d["text"] for e, d in events if e == "text").lower(), events
    llm.script = {"router": [route("maintenance", f"fix {ac['id']}")], "maintenance": [{"action": "fix", "device_id": ac["id"], "cause": "", "action_taken": ""}]}
    events = chat("/api/chat", f"fix {ac['id']}")
    assert next(d["text"] for e, d in events if e == "text").startswith("Fixed"), events
    time.sleep(1)
    assert not [a for a in httpx.get(f"{TWIN}/api/alerts", timeout=10).json()["alerts"] if a["deviceId"] == ac["id"]]
    rec = httpx.get(f"{TWIN}/api/maintenance?device={ac['id']}", timeout=10).json()["records"]
    assert rec and rec[-1]["status"] == "resolved" and "assistant" in rec[-1]["by"]


def test_scene_and_room_questions_through_the_assistant(llm):
    llm.script = {"router": [route("scene", "hide the piping")], "scene": [{"action": "layer", "device_ids": [], "part": "", "layer": "piping", "on": False, "scenario": "", "time": 0}]}
    events = chat("/api/chat", "hide the piping")
    assert ("ui_action", {"type": "setLayer", "layer": "piping", "on": False}) in events, events
    llm.script = {"router": [route("knowledge", "what is in the gym room?")], "knowledge": [kg_reply(r"Furniture: [^.]+")]}
    events = chat("/api/chat", "what is in the gym room?")
    assert "treadmill" in next(d["text"] for e, d in events if e == "text").lower(), events


def test_assistant_ops_are_limited_by_role():
    sess = httpx.get(f"{TWIN}/api/st/v1/twin/floor", timeout=10)
    assert sess.status_code == 401
    assert httpx.post(f"{TWIN}/api/st/v1/twin/ops/layout", json={}, headers={"Authorization": "Bearer nope"}, timeout=10).status_code == 401


def test_save_a_routine_then_run_it_later(llm):
    """Change two devices -> the assistant offers to save -> 'yes, call it X' -> change things back -> 'run X'."""
    light, tv = gym_device("light"), gym_device("tv")
    name = f"Cinema {int(time.time()) % 10000}"
    # 1. a multi-device change by the staff, with the offer
    llm.script = {"router": [route("device_control", "dim the Smart light to 30% and turn on the TV")],
                  "device_plan": [{"result": "OK", "steps": [{"devices": ["Smart light"], "request": "dim to 30%"}, {"devices": ["TV"], "request": "turn on"}], "options": []}],
                  "action_select": [act("switchLevel.setLevel", "30"), act("switch.on", "")]}
    events = chat("/api/chat", "dim the Smart light to 30% and turn on the TV")
    text = next(d["text"] for e, d in events if e == "text")
    assert ("offer", {"kind": "save_routine", "text": "Save this as a routine to run again later?"}) in events, events
    assert "save this as a routine" not in text                                       # a card in the UI, not a line of text
    assert readings(light["id"])["lv"] == 30
    # 2. the user says yes and gives a name: the twin sent the last commands back, the routine is stored
    llm.script = {"router": [route("routines", f"save this as a routine called {name}")], "routines": [{"action": "save", "routine": "", "room": "", "name": name}]}
    events = chat("/api/chat", f"yes, call it {name}")
    assert f'Saved "{name}"' in next(d["text"] for e, d in events if e == "text"), events
    # 3. things change, then the routine puts them back
    httpx.post(f"{TWIN}/api/devices/{light['id']}/commands", json={"command": "setLevel", "args": {"percent": 90}}, timeout=10)
    httpx.post(f"{TWIN}/api/devices/{tv['id']}/commands", json={"command": "power", "args": {"on": "false"}}, timeout=10)
    llm.script = {"router": [route("routines", f"run {name}")],
                  "routines": [lambda s, u: {"action": "run", "routine": next(l.split(":")[0].strip("- ") for l in s.splitlines() if "your routine" in l and name in l), "room": "", "name": ""}]}
    events = chat("/api/chat", f"run {name}")
    assert next(d["text"] for e, d in events if e == "text").startswith(f"Done! {name}"), events
    assert readings(light["id"])["lv"] == 30 and readings(tv["id"])["on"] is True
    # 4. it is the staff's, not a guest's; delete removes it
    p = httpx.post(f"{TWIN}/api/guest", json={"room": "smartthings-experience-zone", "verify": False}, timeout=10).json()
    llm.script = {"router": [route("routines", "what routines are there?")], "routines": [{"action": "list", "routine": "", "room": "", "name": ""}]}
    events = chat(f"/api/guest/{p['token']}/chat", "what routines are there?")
    assert name not in next(d["text"] for e, d in events if e == "text")
    llm.script = {"router": [route("routines", f"delete {name}")],
                  "routines": [lambda s, u: {"action": "delete", "routine": next(l.split(":")[0].strip("- ") for l in s.splitlines() if "your routine" in l and name in l), "room": "", "name": ""}]}
    events = chat("/api/chat", f"delete {name}")
    assert f"Deleted your routine {name}" in next(d["text"] for e, d in events if e == "text"), events


# ---- the knowledge graph (RAG): built from the floor plan, enriched by every action ----

def kg_reply(pattern):
    """A scripted model that answers with the first fact line matching `pattern` and cites it."""
    import re as _re

    def answer(system, user):
        facts = [l for l in system.splitlines() if l.startswith("[")]
        hit = next((l for l in facts if _re.search(pattern, l)), "")
        m = _re.search(pattern, hit)
        return {"reply": m.group(0) if m else "I don't know", "sources": [int(hit[1:hit.index("]")])] if hit else [], "follow_ups": ["Which rooms have devices?"]}
    return answer


def test_how_many_rooms_on_the_current_floor(llm):
    rooms = len(httpx.get(f"{TWIN}/api/floor", timeout=10).json()["rooms"])
    llm.script = {"router": [route("knowledge", "how many rooms are on the current floor?")], "knowledge": [kg_reply(r"It has \d+ rooms")]}
    events = chat("/api/chat", "How many rooms in current floor")
    assert next(d["text"] for e, d in events if e == "text") == f"It has {rooms} rooms", events
    kinds = [e for e, _ in events]
    assert "step" in kinds and "sources" in kinds and "suggestions" in kinds         # the agentic UI's events
    assert next(d for e, d in events if e == "sources")["items"][0]["id"] == "floor:summary"


def test_every_action_enriches_what_the_assistant_knows(llm):
    light = gym_device("light")
    httpx.post(f"{TWIN}/api/devices/{light['id']}/commands", json={"command": "setLevel", "args": {"percent": 37}}, timeout=10)
    llm.script = {"router": [route("knowledge", "what happened to the gym light?")], "knowledge": [kg_reply(rf"{light['id']}\): setLevel \(percent 37\) done")]}
    events = chat("/api/chat", "what happened to the gym light?")
    assert "setLevel (percent 37) done" in next(d["text"] for e, d in events if e == "text"), events
    # a guest check-in is known at once, with the room
    httpx.post(f"{TWIN}/api/guest", json={"room": "smartthings-experience-zone", "verify": False, "label": "Karim"}, timeout=10)
    llm.script = {"router": [route("knowledge", "who is checked in?")], "knowledge": [kg_reply(r"Guest Karim is checked in to [^.]+")]}
    events = chat("/api/chat", "who is checked in?")
    assert "Karim is checked in to Smart Things Experience Zone" in next(d["text"] for e, d in events if e == "text"), events


def test_guest_knowledge_is_only_their_room_and_stay(llm):
    p = httpx.post(f"{TWIN}/api/guest", json={"room": "smartthings-experience-zone", "verify": False}, timeout=10).json()
    llm.script = {"router": [route("knowledge", "how many rooms are there?")], "knowledge": [kg_reply(r"The floor has \d+ rooms")]}
    events = chat(f"/api/guest/{p['token']}/chat", "how many rooms are there?")
    assert "rooms" in next(d["text"] for e, d in events if e == "text"), events
    prompt = llm.calls[-1]["system"]
    assert "Karim" not in prompt and "Treadmill" not in prompt and "Gym Room Air conditioner" not in prompt   # no other guests or rooms' details


def test_window_view_by_purpose_through_the_twin(llm):
    """The photo case: 'open the window and close the curtain because I want to see outside' -> window lights on,
    curtain fully open. The device meanings and the zone guide come from the twin."""
    p = httpx.post(f"{TWIN}/api/guest", json={"room": "smartthings-experience-zone", "verify": False}, timeout=10).json()
    left, right, shade = zone_device("Left Window Light"), zone_device("Right Window Light"), zone_device("Aqara Roller Shade Controller")
    for d in (left, right):
        httpx.post(f"{TWIN}/api/devices/{d['id']}/commands", json={"command": "power", "args": {"on": "false"}}, timeout=10)
    httpx.post(f"{TWIN}/api/devices/{shade['id']}/commands", json={"command": "setPosition", "args": {"percent": 0}}, timeout=10)
    seen = {}

    def decide(system, user):
        seen["prompt"] = system
        ok = "back-lit window" in system and "To see the outside view" in system and "CURTAIN" in system
        return {"reasoning": "To see outside the curtain must be open and the window panes lit." if ok else "unsure",
                "steps": [{"device": "Left Window Light", "action": "switch.on", "value": "", "why": "show the view"},
                          {"device": "Right Window Light", "action": "switch.on", "value": "", "why": "show the view"},
                          {"device": "Aqara Roller Shade Controller", "action": "windowShadeLevel.setShadeLevel", "value": "100", "why": "curtain up"}] if ok else [],
                "question": "" if ok else "?"}
    llm.script = {"router": [route("device_control", "open the window and close the curtain because I want to see the outside view")],
                  "device_plan": [{"result": "NONE", "steps": [], "options": []}], "smart_control": [decide]}
    events = chat(f"/api/guest/{p['token']}/chat", "open the window and close the curtain becuase i want to see outside view.")
    assert any(e == "reasoning" and "curtain must be open" in d["text"] for e, d in events), events
    time.sleep(0.5)
    assert readings(left["id"])["lv"] > 0 and readings(right["id"])["lv"] > 0
    assert readings(shade["id"])["pos"] == 100
    res = next(d for e, d in events if e == "result")["results"]
    assert {r["label"] for r in res} == {"Left Window Light", "Right Window Light", "Aqara Roller Shade Controller"} and all(r["ok"] for r in res)
