"""End-to-end agent flows with a scripted LLM (no network)."""
from fastapi.testclient import TestClient

from app.api import create_app
from app.integrations.smartthings import CommandResult
from app.normalize import build_context
from tests.conftest import FakeLLM, sample_request


def route(skill, request):
    return {"skill": skill, "request": request}


def act(*pairs):
    """action_select reply: act("switch.on", "") or act("switch.on", "", "switchLevel.setLevel", "40")."""
    return {"actions": [{"action": a, "change": "set", "value": v} for a, v in zip(pairs[::2], pairs[1::2])]}


def plan(*steps, result="OK", options=()):
    """device_plan reply: plan((["Light 1", "Light 2"], "turn on"), (["Desk Lamp"], "dim to 40%"))."""
    return {"result": result, "steps": [{"devices": list(d), "request": r} for d, r in steps], "options": list(options)}


async def run(agent, settings, message, **kw):
    return await agent.handle(build_context(sample_request(message, **kw), "user-token", settings))


async def test_exact_name_skips_device_llm_and_executes(make_agent, settings):
    agent, llm = make_agent({
        "router": [route("device_control", "set the Desk Lamp brightness to 40%")],
        "action_select": [act("switchLevel.setLevel", "40")],
    })
    res = await run(agent, settings, "set the Desk Lamp brightness to 40%")
    assert res.status == "success"
    assert llm.labels() == ["router", "action_select"]  # no device_plan call
    assert res.data["command_generated"] == {"commands": [{
        "component": "main", "capability": "switchLevel",
        "command": "setLevel", "arguments": [40]}]}
    assert res.message == "Done! Desk Lamp brightness is set to 40%."


async def test_ambiguous_device_asks_with_exact_names(make_agent, settings):
    agent, _ = make_agent({
        "router": [route("device_control", "turn on the lamp")],
        "device_plan": [plan(result="AMBIGUOUS", options=["Desk Lamp", "TV Lamp", "side lamp"])],
    })
    res = await run(agent, settings, "turn on the lamp")
    assert res.status == "clarify"
    assert res.message == "Which one do you mean: Desk Lamp, TV Lamp or side lamp?"


async def test_follow_up_uses_router_rewrite(make_agent, settings):
    agent, llm = make_agent({
        "router": [route("device_control", "turn on the Blinds Switch")],
        "action_select": [act("switch.on", "")],
    })
    history = [{"text": "turn on the switch", "role": "user"},
               {"text": "Which one do you mean: Blinds Switch or Desk Lamp?", "role": "assistant"},
               {"text": "blinds", "role": "user"}]
    res = await run(agent, settings, "blinds", messages=history)
    assert res.status == "success" and res.data["device_name"] == "Blinds Switch"
    router_prompt = llm.calls[0]["user"]
    assert "Which one do you mean" in router_prompt and router_prompt.endswith("Latest user message: blinds")
    # downstream prompts receive only the standalone request, not the history
    assert llm.labels() == ["router", "action_select"]  # exact name in the rewrite -> no device LLM call
    assert "Which one do you mean" not in llm.calls[1]["system"] + llm.calls[1]["user"]


async def test_invalid_value_gets_deterministic_question(make_agent, settings):
    agent, _ = make_agent({
        "router": [route("device_control", "set the Desk Lamp brightness to 150")],
        "action_select": [act("switchLevel.setLevel", "150")],
    })
    res = await run(agent, settings, "set the Desk Lamp brightness to 150")
    assert res.status == "clarify" and "between 1 and 100" in res.message


async def test_missing_value_and_unsupported_action(make_agent, settings):
    agent, _ = make_agent({
        "router": [route("device_control", "change the Blinds Switch channel"), route("device_control", "set the Blinds Switch to cool mode")],
        "action_select": [act("UNCLEAR", ""), act("NONE", "")],
    })
    r1 = await run(agent, settings, "change the Blinds Switch channel")
    assert r1.status == "clarify" and r1.message.startswith("What would you like to do with Blinds Switch?")
    r2 = await run(agent, settings, "set the Blinds Switch to cool mode")
    assert r2.status == "clarify" and "can't do that" in r2.message


async def test_smartthings_failure_is_reported(make_agent, settings):
    agent, _ = make_agent({
        "router": [route("device_control", "turn off the Blinds Switch")],
        "action_select": [act("switch.off", "")],
    })
    skill = next(s for s in agent.skills if s.name == "device_control")
    seen = {}

    async def failing(device_id, commands, token):
        seen.update(device_id=device_id, token=token)
        return CommandResult(False, 401, {"error": "unauthorized"}, "HTTP 401")

    skill.st.execute = failing
    res = await run(agent, settings, "turn off the Blinds Switch")
    assert res.status == "error" and "HTTP 401" in res.message
    assert seen["token"] == "user-token"


def record_calls(agent, fail_for=()):
    """Replace the SmartThings client with a recorder. Returns {device_name: [commands]} (one entry per POST)."""
    skill = next(s for s in agent.skills if s.name == "device_control")
    names = {}
    sent = {}

    async def execute(device_id, commands, token):
        name = names.setdefault(device_id, next(d for d in skill._devices if d.id == device_id).name)
        assert name not in sent, f"{name} got more than one API call"
        sent[name] = commands
        if name in fail_for:
            return CommandResult(False, 500, {"error": "boom"}, "HTTP 500")
        return CommandResult(True, 200, {"ok": True})

    original_plan = skill.plan

    async def plan(ctx, request):  # remember the devices so ids can be mapped back to names
        skill._devices = ctx.devices
        return await original_plan(ctx, request)

    skill.plan = plan
    skill.st.execute = execute
    return sent


def by_target(**replies):
    """action_select reply chosen by the device(s) named in the prompt: by_target(Light_1=act(...))."""
    def pick(system, user):
        for name, reply in replies.items():
            if f'"{name.replace("_", " ")}"' in system:
                return reply
        raise AssertionError(f"no scripted action for prompt: {system[:80]}")
    return pick


async def test_turn_on_all_lights_groups_identical_devices(make_agent, settings):
    lights = ["Desk Lamp", "Left Window Light", "Light 1", "Light 2", "Light 3", "Light 4",
              "Right Window Light", "TV Lamp", "Light 5", "side lamp"]
    agent, llm = make_agent({
        "router": [route("device_control", "turn on all the lights")],
        "device_plan": [plan((lights, "turn on"))],
        "action_select": [act("switch.on", ""), act("switch.on", "")],
    })
    sent = record_calls(agent)
    res = await run(agent, settings, "turn on all the lights")
    assert res.status == "success"
    # dimmable lights share one action set, on/off-only lights another -> 2 action calls, not 10
    assert llm.labels() == ["router", "device_plan", "action_select", "action_select"]
    assert "the devices" in llm.calls[2]["system"] and '"Light 3"' in llm.calls[2]["system"]
    assert sorted(sent) == sorted(lights)
    on = {"component": "main", "capability": "switch", "command": "on", "arguments": []}
    assert all(cmds == [on] for cmds in sent.values())
    assert len(res.data["results"]) == 10 and "device_id" not in res.data
    assert res.message.startswith("Done! Turned on ") and all(n in res.message for n in lights)


async def test_different_actions_on_different_devices(make_agent, settings):
    agent, llm = make_agent({
        "router": [route("device_control", "turn on Light 1 and set the Desk Lamp brightness to 40%")],
        "device_plan": [plan((["Light 1"], "turn on"), (["Desk Lamp"], "set brightness to 40%"))],
        "action_select": [by_target(Light_1=act("switch.on", ""), Desk_Lamp=act("switchLevel.setLevel", "40"))] * 2,
    })
    sent = record_calls(agent)
    res = await run(agent, settings, "turn on Light 1 and set the Desk Lamp brightness to 40%")
    assert res.status == "success"
    assert sent["Light 1"] == [{"component": "main", "capability": "switch", "command": "on", "arguments": []}]
    assert sent["Desk Lamp"] == [{"component": "main", "capability": "switchLevel", "command": "setLevel", "arguments": [40]}]
    assert res.message == "Done! Turned on Light 1, and set Desk Lamp brightness to 40%."
    # each action prompt gets only its own step, never the other device's instruction
    action_users = [c["user"] for c in llm.calls if c["label"] == "action_select"]
    assert sorted(action_users) == ["Request: set brightness to 40%", "Request: turn on"]


async def test_several_commands_on_one_device_go_in_one_api_call(make_agent, settings):
    agent, _ = make_agent({
        "router": [route("device_control", "turn on the Desk Lamp and set it to 40% and 3000K")],
        "device_plan": [plan((["Desk Lamp"], "turn on, brightness 40%, color temperature 3000K"))],
        "action_select": [act("switch.on", "", "switchLevel.setLevel", "40", "colorTemperature.setColorTemperature", "3000")],
    })
    sent = record_calls(agent)
    res = await run(agent, settings, "turn on the Desk Lamp and set it to 40% and 3000K")
    assert res.status == "success"
    assert [c["command"] for c in sent["Desk Lamp"]] == ["on", "setLevel", "setColorTemperature"]
    assert sent["Desk Lamp"][1]["arguments"] == [40] and sent["Desk Lamp"][2]["arguments"] == [3000]
    # one device -> the single-device fields stay at the top level, with all commands
    assert res.data["device_name"] == "Desk Lamp" and len(res.data["command_generated"]["commands"]) == 3
    assert res.message == ("Done! Turned on Desk Lamp, set Desk Lamp brightness to 40%, "
                           "and set Desk Lamp color temperature to 3000K.")


async def test_same_device_in_two_steps_is_merged_into_one_call(make_agent, settings):
    agent, _ = make_agent({
        "router": [route("device_control", "turn on Light 1 and Light 2, and dim Light 1 to 20%")],
        "device_plan": [plan((["Light 1", "Light 2"], "turn on"), (["Light 1"], "dim to 20%"))],
        "action_select": [act("switch.on", ""), act("switchLevel.setLevel", "20")],
    })
    sent = record_calls(agent)
    res = await run(agent, settings, "turn on Light 1 and Light 2, and dim Light 1 to 20%")
    assert res.status == "success"
    assert [c["command"] for c in sent["Light 1"]] == ["on", "setLevel"]
    assert [c["command"] for c in sent["Light 2"]] == ["on"]


async def test_nothing_runs_while_part_of_the_request_needs_a_question(make_agent, settings):
    agent, _ = make_agent({
        "router": [route("device_control", "turn on Light 1 and dim the Desk Lamp")],
        "device_plan": [plan((["Light 1"], "turn on"), (["Desk Lamp"], "dim"))],
        "action_select": [by_target(Light_1=act("switch.on", ""), Desk_Lamp=act("switchLevel.setLevel", ""))] * 2,
    })
    sent = record_calls(agent)
    res = await run(agent, settings, "turn on Light 1 and dim the Desk Lamp")
    assert res.status == "clarify" and sent == {}
    assert res.message == "Desk Lamp: What value would you like for set brightness / dimmer level (1-100)?"


async def test_ambiguous_part_asks_before_running_anything(make_agent, settings):
    agent, llm = make_agent({
        "router": [route("device_control", "turn on Light 1 and the lamp")],
        "device_plan": [plan((["Light 1"], "turn on"), result="AMBIGUOUS", options=["Desk Lamp", "TV Lamp"])],
    })
    sent = record_calls(agent)
    res = await run(agent, settings, "turn on Light 1 and the lamp")
    assert res.status == "clarify" and sent == {} and "action_select" not in llm.labels()
    assert res.message == "Which one do you mean: Desk Lamp or TV Lamp?"


async def test_unsupported_device_is_skipped_and_failures_are_reported(make_agent, settings):
    agent, _ = make_agent({
        "router": [route("device_control", "turn off everything")],
        "device_plan": [plan((["Aqara Roller Shade Controller", "Light 1", "Blinds Switch"], "turn off"))],
        "action_select": [by_target(Aqara_Roller_Shade_Controller=act("NONE", ""),
                                    Light_1=act("switch.off", ""), Blinds_Switch=act("switch.off", ""))] * 3,
    })
    sent = record_calls(agent, fail_for={"Blinds Switch"})
    res = await run(agent, settings, "turn off everything")
    assert res.status == "success" and sorted(sent) == ["Blinds Switch", "Light 1"]
    assert res.message == (
        "Done! Light 1 is turned off. But I couldn't control Blinds Switch right now (HTTP 500). "
        "Sorry, Aqara Roller Shade Controller can't do that in this demo. It can: open, close, set blinds / shade position."
    )
    statuses = {r["device_name"]: r["status"] for r in res.data["results"]}
    assert statuses == {"Light 1": "success", "Blinds Switch": "error"}


async def test_prompts_are_small_and_never_contain_device_ids(make_agent, settings, devices):
    agent, llm = make_agent({
        "router": [route("device_control", "turn on the lamp"), route("device_info", "how many devices are there?")],
        "device_plan": [plan((["Desk Lamp"], "turn on"))],
        "action_select": [act("switch.on", "")],
        "device_info": [{"reply": "There are 9 devices."}],
    })
    await run(agent, settings, "turn on the lamp")
    await run(agent, settings, "how many devices are there?")
    for call in llm.calls:
        text = call["system"] + call["user"]
        assert len(text) < 2500, (call["label"], len(text))
        assert not any(d.id in text for d in devices), call["label"]
    # "Right Window Light" appears in no skill example, so it proves the device list is not sent to the router
    assert "router" == llm.calls[0]["label"] and "Right Window Light" not in llm.calls[0]["system"]


async def test_chitchat_and_router_failure(make_agent, settings):
    agent, llm = make_agent({"router": [route("chitchat", "hello")], "chitchat": [{"reply": "Hi! I'm SmartThingsBot."}]})
    res = await run(agent, settings, "hello")
    assert res.status == "clarify" and res.data["skill"] == "chitchat"
    assert "control the devices" in llm.calls[-1]["system"]  # capabilities listed
    res = await run(agent, settings, "hello again")  # script exhausted -> LLMError
    assert res.status == "error"


async def test_location_skill_uses_only_relevant_data(make_agent, settings):
    agent, llm = make_agent({
        "router": [route("location", "where is the restroom?")],
        "location": [{"reply": "From reception, turn right."}],
    })
    res = await run(agent, settings, "where is the restroom?")
    assert res.status == "clarify"
    assert llm.calls[-1]["system"].index("Restroom") < llm.calls[-1]["system"].index("Living Room")


async def test_location_skill_is_off_by_default(make_agent, settings):
    agent, llm = make_agent({"router": [route("chitchat", "hi")], "chitchat": [{"reply": "Hi"}]},
                            location_skill_enabled=False)
    await run(agent, settings, "hi", location_context={"places": [{"name": "Cafe"}]})
    assert "location" not in llm.calls[0]["schema"]["properties"]["skill"]["enum"]


async def test_location_hidden_without_data(make_agent, settings, tmp_path):
    agent, llm = make_agent({"router": [route("chitchat", "hi")], "chitchat": [{"reply": "Hi"}]},
                            location_data_path=tmp_path / "missing.json")
    await run(agent, settings, "hi")
    assert "location" not in llm.calls[0]["schema"]["properties"]["skill"]["enum"]
    # ...but a per-request location_context enables it
    agent2, llm2 = make_agent({"router": [route("chitchat", "hi")], "chitchat": [{"reply": "Hi"}]},
                              location_data_path=tmp_path / "missing.json")
    await run(agent2, settings, "hi", location_context={"places": [{"name": "Cafe"}]})
    assert "location" in llm2.calls[0]["schema"]["properties"]["skill"]["enum"]


def test_http_contract_matches_frontend(settings):
    llm = FakeLLM({
        "router": [route("device_control", "turn on the Blinds Switch"), route("chitchat", "hi")],
        "action_select": [act("switch.on", "")],
        "chitchat": [{"reply": "Hello!"}],
    })
    client = TestClient(create_app(settings, llm))
    body = sample_request("turn on the Blinds Switch").model_dump()
    r = client.post("/control", json=body, headers={"Authorization": "Bearer abc"}).json()
    assert r["status"] == "success" and r["message"] == "Done! Blinds Switch is turned on."
    assert r["data"]["device_name"] == "Blinds Switch" and r["data"]["api_result"]["status_code"] == 200
    r = client.post("/control", json=sample_request("hi").model_dump()).json()
    # ChatBot.tsx: data.data?.status === "clarify" ? data.data.question : data.message
    assert r["data"]["status"] == "clarify" and r["data"]["question"] == "Hello!" == r["message"]
    assert {s["name"] for s in client.get("/skills").json()} == {"device_control", "device_info", "device_status", "chitchat", "location", "rooms"}


def _parse_sse(body: str) -> list[tuple[str, dict]]:
    import json
    out = []
    for block in body.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        out.append((lines["event"], json.loads(lines["data"])))
    return out


def test_control_stream_sends_progress_then_final(settings):
    llm = FakeLLM({
        "router": [route("device_control", "set the Desk Lamp brightness to 40%")],
        "action_select": [act("switchLevel.setLevel", "40")],
    })
    client = TestClient(create_app(settings, llm))
    payload = sample_request("set the Desk Lamp brightness to 40%").model_dump()
    with client.stream("POST", "/control/stream", json=payload) as res:
        assert res.status_code == 200
        assert res.headers["content-type"].startswith("text/event-stream")
        events = _parse_sse(res.read().decode())
    stages = [d["stage"] for e, d in events if e == "status"]
    assert stages == ["routing", "device_control", "device_control.action", "device_control.send"]
    kind, final = events[-1]
    assert kind == "final" and final["status"] == "success"
    # identical body to the non-streaming endpoint
    llm.script = {
        "router": [route("device_control", "set the Desk Lamp brightness to 40%")],
        "action_select": [act("switchLevel.setLevel", "40")],
    }
    assert client.post("/control", json=payload).json() == final


def test_control_stream_reports_agent_errors_as_reply(settings):
    client = TestClient(create_app(settings, FakeLLM({})))  # router has no scripted reply -> LLMError
    with client.stream("POST", "/control/stream", json=sample_request("hi").model_dump()) as res:
        events = _parse_sse(res.read().decode())
    assert events[0] == ("status", {"stage": "routing", "text": "Understanding"})
    assert events[-1][0] == "final" and events[-1][1]["status"] == "error"
