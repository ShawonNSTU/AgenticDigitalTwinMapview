"""Live device state: status readings, relative changes ("by 5%") and the device_status skill."""
import pytest

from app.devices.catalog import ValueProblem, build_actions
from app.devices.state import DeviceState, format_value, setter_attribute
from app.integrations.smartthings import CommandResult
from app.normalize import build_devices
from tests.conftest import sample_request
from tests.test_agent import record_calls, route, run


def change(action, direction, value=""):
    return {"actions": [{"action": action, "change": direction, "value": value}]}


def lamp(on=True, level=70, kelvin=3000):
    return {"main": {
        "switch": {"switch": {"value": "on" if on else "off"}},
        "switchLevel": {"level": {"value": level, "unit": "%"}},
        "colorTemperature": {"colorTemperature": {"value": kelvin, "unit": "K"}},
        "colorControl": {"hue": {"value": None}, "saturation": {"value": None}},
    }}


def fake_status(agent, skill_name, by_name, offline=(), calls=None):
    """Serve /status and /health from {device name: components | None (= read fails)}."""
    skill = next(s for s in agent.skills if s.name == skill_name)
    names = {d.id: d.name for d in build_devices(sample_request())}

    async def get_status(device_id, token):
        name = names[device_id]
        if calls is not None:
            calls.append(name)
        comps = by_name.get(name)
        if comps is None:
            return CommandResult(False, 401, {"error": "unauthorized"}, "HTTP 401")
        return CommandResult(True, 200, {"components": comps})

    async def get_health(device_id, token):
        return CommandResult(True, 200, {"state": "OFFLINE" if names[device_id] in offline else "ONLINE"})

    skill.st.get_status = get_status
    skill.st.get_health = get_health
    return skill


# ---------- units: readings ----------

def test_readings_lines_and_units(devices):
    desk = next(d for d in devices if d.name == "Desk Lamp")
    state = DeviceState(desk, components=lamp(level=40), online=True)
    assert state.line() == "- Desk Lamp: power on, brightness 40%, color temperature 3000K"  # null hue skipped
    assert state.number("switchLevel", "level") == 40
    assert DeviceState(desk, online=False, components=lamp()).line() == "- Desk Lamp: OFFLINE, no current readings"
    assert "could not be read (HTTP 401)" in DeviceState(desk, error="HTTP 401").line()
    assert format_value(23.5, "C") == "23.5°C" and format_value(12.0, "W") == "12 W"
    assert setter_attribute("windowShadeLevel", "setShadeLevel") == "shadeLevel"
    assert setter_attribute("switchLevel", "setLevel") == "level"


def test_stepped_values_are_clamped_and_scaled(devices):
    desk = {a.id: a for a in build_actions(next(d for d in devices if d.name == "Desk Lamp"))}
    level, kelvin = desk["switchLevel.setLevel"], desk["colorTemperature.setColorTemperature"]
    assert level.change_amount("5%") == (5.0, True)
    assert level.stepped(70, +1, 5, True) == ([75], "75")
    assert level.stepped(98, +1, 5, False) == ([100], "100")       # clamped to the range
    assert level.stepped(5, -1, None, False) == ([1], "1")         # default step 10, min 1
    assert kelvin.stepped(3000, +1, None, False) == ([3500], "3500")  # default step 500K
    assert kelvin.stepped(3000, +1, 10, True) == ([3430], "3430")     # 10% of the 2200-6500 range
    with pytest.raises(ValueProblem):
        desk["switch.on"].change_amount("5")


# ---------- device_control: relative changes ----------

async def test_increase_brightness_reads_current_value(make_agent, settings):
    agent, llm = make_agent({
        "router": [route("device_control", "increase the Desk Lamp brightness by 5%")],
        "action_select": [change("switchLevel.setLevel", "increase", "5%")],
    })
    fake_status(agent, "device_control", {"Desk Lamp": lamp(level=70)})
    sent = record_calls(agent)
    res = await run(agent, settings, "increase the Desk Lamp brightness by 5%")
    assert res.status == "success"
    assert sent["Desk Lamp"] == [{"component": "main", "capability": "switchLevel", "command": "setLevel", "arguments": [75]}]
    assert res.message == "Done! Desk Lamp brightness is set to 75%."
    assert '"change"' in llm.calls[-1]["system"]


async def test_brighter_on_an_off_light_turns_it_on_first(make_agent, settings):
    agent, _ = make_agent({
        "router": [route("device_control", "make the Desk Lamp a bit brighter")],
        "action_select": [change("switchLevel.setLevel", "increase")],
    })
    fake_status(agent, "device_control", {"Desk Lamp": lamp(on=False, level=30)})
    sent = record_calls(agent)
    res = await run(agent, settings, "make the Desk Lamp a bit brighter")
    assert res.status == "success"
    assert [(c["command"], c["arguments"]) for c in sent["Desk Lamp"]] == [("on", []), ("setLevel", [40])]
    assert res.message == "Done! Turned on Desk Lamp, and set Desk Lamp brightness to 40%."


async def test_relative_change_per_device(make_agent, settings):
    agent, _ = make_agent({
        "router": [route("device_control", "dim Light 1 and Light 2 by 10")],
        "device_plan": [{"result": "OK", "steps": [{"devices": ["Light 1", "Light 2"], "request": "dim by 10"}], "options": []}],
        "action_select": [change("switchLevel.setLevel", "decrease", "10")],
    })
    calls = []
    fake_status(agent, "device_control", {"Light 1": lamp(level=30), "Light 2": lamp(level=55)}, calls=calls)
    sent = record_calls(agent)
    res = await run(agent, settings, "dim Light 1 and Light 2 by 10")
    assert res.status == "success" and sorted(calls) == ["Light 1", "Light 2"]
    assert sent["Light 1"][0]["arguments"] == [20] and sent["Light 2"][0]["arguments"] == [45]


async def test_already_at_max_sends_nothing(make_agent, settings):
    agent, _ = make_agent({
        "router": [route("device_control", "increase the Desk Lamp brightness")],
        "action_select": [change("switchLevel.setLevel", "increase")],
    })
    fake_status(agent, "device_control", {"Desk Lamp": lamp(level=100)})
    sent = record_calls(agent)
    res = await run(agent, settings, "increase the Desk Lamp brightness")
    assert res.status == "clarify" and sent == {}
    assert res.message == "Desk Lamp brightness is already at 100%."


async def test_unreadable_status_leaves_device_unchanged(make_agent, settings):
    agent, _ = make_agent({
        "router": [route("device_control", "increase the Desk Lamp brightness by 5")],
        "action_select": [change("switchLevel.setLevel", "increase", "5")],
    })
    fake_status(agent, "device_control", {"Desk Lamp": None})
    sent = record_calls(agent)
    res = await run(agent, settings, "increase the Desk Lamp brightness by 5")
    assert res.status == "clarify" and sent == {}
    assert res.message == "I couldn't read the current brightness of Desk Lamp, so I left it unchanged."


async def test_absolute_changes_do_not_read_status(make_agent, settings):
    agent, _ = make_agent({
        "router": [route("device_control", "set the Desk Lamp brightness to 40%")],
        "action_select": [change("switchLevel.setLevel", "set", "40")],
    })
    calls = []
    fake_status(agent, "device_control", {}, calls=calls)
    record_calls(agent)
    res = await run(agent, settings, "set the Desk Lamp brightness to 40%")
    assert res.status == "success" and calls == []


# ---------- device_status skill ----------

async def test_status_question_answers_from_live_readings(make_agent, settings, devices):
    agent, llm = make_agent({
        "router": [route("device_status", "is the Desk Lamp on?")],
        "device_status": [{"reply": "Yes, the Desk Lamp is on at 70% brightness."}],
    })
    fake_status(agent, "device_status", {"Desk Lamp": lamp(level=70)})
    res = await run(agent, settings, "is the Desk Lamp on?")
    assert res.status == "clarify" and res.message == "Yes, the Desk Lamp is on at 70% brightness."
    assert llm.labels() == ["router", "device_status"]  # exact name -> no target LLM call
    prompt = llm.calls[-1]["system"]
    assert "): power on, brightness 70%, color temperature 3000K" in prompt  # "- Desk Lamp (room: ...)"
    assert not any(d.id in prompt for d in devices) and len(prompt) < 2500
    assert res.data["states"][0]["readings"]["brightness"] == "70%"


async def test_which_lights_are_on_uses_target_step(make_agent, settings):
    lights = ["Desk Lamp", "Light 1", "TV Lamp"]
    agent, llm = make_agent({
        "router": [route("device_status", "which lights are on?")],
        "status_targets": [{"result": "OK", "devices": lights}],
        "device_status": [{"reply": "Desk Lamp and TV Lamp are on."}],
    })
    tv = {"main": {"switch": {"switch": {"value": "on"}}}}
    fake_status(agent, "device_status", {"Desk Lamp": lamp(), "Light 1": lamp(on=False), "TV Lamp": tv}, offline=["Light 1"])
    res = await run(agent, settings, "which lights are on?")
    assert llm.labels() == ["router", "status_targets", "device_status"]
    prompt = llm.calls[-1]["system"]
    lines = {l.split(" (room")[0]: l for l in prompt.splitlines() if l.startswith("- ")}
    assert lines["- Light 1"].endswith(": OFFLINE, no current readings")
    assert lines["- TV Lamp"].endswith(": power on")
    assert [s["online"] for s in res.data["states"]] == [True, False, True]


async def test_status_unreadable_answers_without_llm(make_agent, settings):
    agent, llm = make_agent({"router": [route("device_status", "is Light 1 on?")]})
    fake_status(agent, "device_status", {"Light 1": None})
    res = await run(agent, settings, "is Light 1 on?")
    assert res.status == "clarify" and llm.labels() == ["router"]
    assert res.message == "Sorry, I couldn't read the current status of Light 1 (HTTP 401)."
