"""Guest room assistant: what requests turn into, and how partial failures are reported."""
import asyncio

from app.guest_agent import read_request, execute, result_text, plan_text

CMDS = {
    "ac": ["power", "setTemperature", "setMode", "setFanSpeed", "setSwing", "setTimer"],
    "light": ["power", "setLevel", "setColorTemperature"], "tv": ["power", "setVolume", "setInput"],
    "blinds": ["open", "close", "setPosition"], "fan": ["power", "setSpeed", "setOscillation"],
    "purifier": ["power", "setFan"], "vacuum": ["start", "dock"], "lock": ["lock"],
}


def dev(i, t, name, **readings):
    return {"id": i, "type": t, "name": name, "label": name, "readings": {"set": 24, **readings}, "overrides": {}, "online": True,
            "commands": [{"name": c, "args": {}} for c in CMDS[t]]}


VIEW = {"room": {"key": "r403", "name": "Room 403"}, "devices": [
    dev("AC-01", "ac", "Air conditioner"), dev("LT-01", "light", "Ceiling light"), dev("LT-02", "light", "Reading light"),
    dev("TV-01", "tv", "TV"), dev("BL-01", "blinds", "Smart blinds"), dev("FN-01", "fan", "Fan"),
    dev("AP-01", "purifier", "Air purifier"), dev("VC-01", "vacuum", "Robot vacuum"), dev("DL-01", "lock", "Door lock")]}


def cmds(plan):
    return {(a["device_id"], a["command"], tuple(sorted(a["args"].items()))) for a in plan["actions"]}


def test_ac_and_lights_run_directly():
    p = read_request("Set the AC to 24 degrees and dim the lights", VIEW)
    c = cmds(p)
    assert ("AC-01", "setTemperature", (("celsius", 24),)) in c
    assert ("LT-01", "setLevel", (("percent", 30),)) in c and ("LT-02", "setLevel", (("percent", 30),)) in c
    assert p["ask_first"] is False


def test_sleep_scene_asks_first():
    p = read_request("Make the room comfortable for sleeping.", VIEW)
    assert p["ask_first"] is True and p["scene"] == "sleep"
    c = cmds(p)
    assert ("AC-01", "setTemperature", (("celsius", 24),)) in c
    assert ("BL-01", "close", ()) in c and ("TV-01", "power", (("on", "false"),)) in c
    assert ("LT-02", "setLevel", (("percent", 10),)) in c and ("LT-01", "setLevel", (("percent", 0),)) in c
    assert "Shall I go ahead" in plan_text(p, False)


def test_examples_from_the_brief():
    assert ("AC-01", "power", (("on", "true"),)) in cmds(read_request("Turn on the air conditioner.", VIEW))
    assert ("TV-01", "power", (("on", "false"),)) in cmds(read_request("Turn off the TV.", VIEW))
    assert ("VC-01", "start", ()) in cmds(read_request("Start cleaning the room.", VIEW))
    assert any(a["command"] == "setLevel" for a in read_request("Dim the lights.", VIEW)["actions"])


def test_bangla_request():
    p = read_request("এসি ২৪ ডিগ্রি করো", VIEW)
    assert ("AC-01", "setTemperature", (("celsius", 24),)) in cmds(p)


def test_missing_device_and_no_unlock_permission():
    no_tv = {"room": VIEW["room"], "devices": [d for d in VIEW["devices"] if d["type"] != "tv"]}
    p = read_request("turn on the tv", no_tv)
    assert not p["actions"] and "TV" in plan_text(p, False)
    p = read_request("unlock the door", VIEW)
    assert not p["actions"] and any("unlock" in m for m in p["missing"])


class FakePlatform:
    async def command(self, device_id, command, args):
        if device_id == "AC-01":
            return {"ok": False, "offline": True, "error": "Air conditioner AC-01 is offline and did not respond"}
        return {"ok": True}


def test_partial_failure_is_reported_per_device():
    p = read_request("Set the AC to 24 degrees and dim the lights", VIEW)
    res = asyncio.run(execute(FakePlatform(), p["actions"]))
    assert {r["device_id"]: r["ok"] for r in res} == {"AC-01": False, "LT-01": True, "LT-02": True}
    text = result_text(res, False)
    assert "Ceiling light" in text and "did not respond" in text and "offline" in text
