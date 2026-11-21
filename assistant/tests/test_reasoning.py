"""Reasoning streamed from the model, and smart (goal-based) control that thinks about the current state."""
from __future__ import annotations

import json
import threading
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from fastapi.testclient import TestClient

from app.api import create_app
from app.config import Settings
from app.core.llm import OllamaLLM
from app.core.trace import reasoning_sink
from app.integrations.smartthings import CommandResult
from app.normalize import build_context
from tests.conftest import FakeLLM, sample_request

SCHEMA = {"type": "object", "properties": {"reply": {"type": "string"}}, "required": ["reply"]}


def streaming_ollama(chunks):
    """A fake Ollama that streams NDJSON: thinking first, then the reply."""
    seen = []

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass

        def do_POST(self):
            seen.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(200); self.send_header("Content-Type", "application/x-ndjson"); self.end_headers()
            for th, c in chunks:
                self.wfile.write((json.dumps({"model": "m", "created_at": "2026-01-01T00:00:00Z", "message": {"role": "assistant", "content": c, "thinking": th}, "done": False}) + "\n").encode())
            self.wfile.write((json.dumps({"model": "m", "created_at": "2026-01-01T00:00:00Z", "message": {"role": "assistant", "content": ""}, "done": True}) + "\n").encode())

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}", seen


async def test_thinking_streams_to_the_sink_for_reasoning_steps_only():
    srv, url, seen = streaming_ollama([("The user asks about rooms. ", ""), ("The overview says 29.", ""), ("", '{"reply": '), ("", '"29 rooms"}')])
    try:
        llm = OllamaLLM(replace(Settings(), ollama_base_url=url, ollama_model="qwen3.5:35b", ollama_think="false", llm_timeout_s=5))
        got = []
        tok = reasoning_sink.set(lambda label, t: got.append((label, t)))
        try:
            out = await llm.complete_json(system="s", user="u", schema=SCHEMA, label="knowledge")
            assert out == {"reply": "29 rooms"}
            assert "".join(t for _, t in got) == "The user asks about rooms. The overview says 29." and seen[-1]["think"] is True
            got.clear()
            await llm.complete_json(system="s", user="u", schema=SCHEMA, label="router")
            assert got == [] and seen[-1]["think"] is False                     # routing stays fast, no thinking
        finally:
            reasoning_sink.reset(tok)
    finally:
        srv.shutdown()


def plan(reasoning, *steps, question=""):
    return {"reasoning": reasoning, "steps": [{"device": d, "action": a, "value": v, "why": w} for d, a, v, w in steps], "question": question}


async def test_smart_control_reads_state_reasons_and_sends_validated_commands(make_agent, settings):
    agent, llm = make_agent({"router": [{"skill": "smart_control", "request": "it's too bright in here"}],
                             "smart_control": [plan("Too bright: dim the desk lamp and close the shade.", ("Desk Lamp", "switchLevel.setLevel", "30", "less glare"),
                                                    ("Desk Lamp", "switchLevel.setLevel", "250", "bad value"), ("Blinds Switch", "switchLevel.setLevel", "50", "a switch has no level"))]})
    skill = next(s for s in agent.skills if s.name == "smart_control")
    sent = []

    async def execute(dev, cmds, token):
        sent.append((dev, cmds)); return CommandResult(True, 200, {})
    skill.st.execute = execute

    async def status(dev, token):
        return CommandResult(True, 200, {"components": {"main": {"switch": {"switch": {"value": "on"}}, "switchLevel": {"level": {"value": 90}}}}})
    skill.st.get_status = status
    reasons = []
    ctx = build_context(sample_request("it's too bright in here", extras={"role": "admin"}), "tok", settings)
    ctx.on_reasoning = lambda label, t: reasons.append(t)
    res = await agent.handle(ctx)
    assert res.status == "success" and "**Desk Lamp**" in res.message and "less glare" in res.message
    assert len(sent) == 1 and sent[0][1] == [{"component": "main", "capability": "switchLevel", "command": "setLevel", "arguments": [30]}]
    assert "Left alone" in res.message                                          # invalid steps reported, not sent
    assert "Too bright" in "".join(reasons)                                     # the plan's reasoning is shown
    assert "brightness 90%" in llm.calls[-1]["system"]                          # it reasoned from the live state


async def test_smart_control_asks_when_too_vague(make_agent, settings):
    agent, _ = make_agent({"router": [{"skill": "smart_control", "request": "fix it"}], "smart_control": [plan("Unclear.", question="What would you like to change, the lights or the shade?")]})
    skill = next(s for s in agent.skills if s.name == "smart_control")

    async def status(dev, token):
        return CommandResult(True, 200, {"components": {"main": {}}})
    skill.st.get_status = status
    res = await agent.handle(build_context(sample_request("fix it", extras={"role": "admin"}), "tok", settings))
    assert res.status == "clarify" and res.message.startswith("What would you like")


def test_reasoning_events_reach_the_stream(settings):
    class Thinking(FakeLLM):
        async def complete_json(self, **kw):
            from app.core.trace import emit
            emit(kw["label"], "thinking about it")
            return await super().complete_json(**kw)

    client = TestClient(create_app(settings, Thinking({"router": [{"skill": "chitchat", "request": "hi"}], "chitchat": [{"reply": "Hello!"}]})))
    with client.stream("POST", "/control/stream", json=sample_request("hi").model_dump()) as r:
        text = "".join(r.iter_text())
    assert "event: reasoning" in text and "thinking about it" in text and "event: final" in text


async def test_window_and_curtain_by_purpose(make_agent, settings):
    """'open the window and close the curtain because I want to see outside': the literal skill can't map
    'window' to a device, hands over; the reasoning skill reads what each device is plus the room guide and
    acts on the purpose (window lights on, shade fully open), saying why."""
    from app.normalize import build_context as bc
    agent, llm = make_agent({
        "router": [{"skill": "device_control", "request": "open the window and close the curtain because I want to see the outside view"}],
        "device_plan": [{"result": "NONE", "steps": [], "options": []}],
        "smart_control": [lambda s, u: plan("To see outside the curtain must be open, not closed, and the window panes lit.",
                                            ("Left Window Light", "switch.on", "", "show the view"), ("Right Window Light", "switch.on", "", "show the view"),
                                            ("Aqara Roller Shade Controller", "windowShadeLevel.setShadeLevel", "100", "curtain fully up"))
                          if "back-lit window" in s and "To see the outside view" in s else plan("?", question="?")],
    })
    skill = next(x for x in agent.skills if x.name == "smart_control")
    sent = []

    async def execute(dev, cmds, token):
        sent.append((dev, cmds)); return CommandResult(True, 200, {})

    async def status(dev, token):
        return CommandResult(True, 200, {"components": {"main": {"switch": {"switch": {"value": "off"}}}}})
    skill.st.execute, skill.st.get_status = execute, status
    req = sample_request("open the window and close the curtain becuase i want to see outside view.", extras={"role": "guest", "room_guide": [
        "Zone: To see the outside view: open the curtain fully (Aqara Roller Shade Controller to 100 %) AND turn on both window lights."]})
    for d in req.devices or []:
        pass
    ctx = bc(req, "tok", settings)
    for d in ctx.devices:
        if "Window Light" in d.name:
            d.about = "Real SmartThings device. The window of the room: a back-lit window pane behind the roller shade."
        if d.name == "Aqara Roller Shade Controller":
            d.about = "The CURTAIN in front of both windows. 100 % = fully open."
    reasons = []
    ctx.on_reasoning = lambda label, t: reasons.append(t)
    res = await agent.handle(ctx)
    assert res.status == "success", res.message
    assert {c["arguments"][0] if c["arguments"] else c["command"] for _, cmds in sent for c in cmds} >= {"on", 100}
    assert "curtain must be open" in "".join(reasons) and "could not map" in "".join(reasons)
    assert res.data["skill"] == "smart_control" and res.data.get("save_offer")
