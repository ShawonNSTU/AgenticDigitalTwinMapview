"""Several tasks in one message: plan (to-do list), work through them in order or in parallel, tick them off."""
from __future__ import annotations

import asyncio
import time

from app.core.agent import Agent
from app.integrations.twin import TwinResult
from app.normalize import build_context
from tests.conftest import FakeLLM, sample_request
from tests.test_knowledge import DOCS


class Twin:
    def __init__(self):
        self.calls = []

    async def kg(self, token):
        await asyncio.sleep(0.2)
        return TwinResult(True, {"version": "1", "docs": DOCS})

    async def op(self, name, payload, token):
        self.calls.append((name, payload))
        if name == "routines":
            return TwinResult(True, {"routines": [{"id": "movie", "name": "Movie night", "about": "x"}], "rooms": []})
        if name == "routine_save":
            return TwinResult(True, {"ok": True, "id": "c-cinema", "name": "Cinema", "steps": len(payload["actions"][0]["commands"]), "devices": 1})
        return TwinResult(False, error="n/a")


def agent_with(settings, script):
    llm = FakeLLM(script)
    agent = Agent(llm, settings)
    twin = Twin()
    for s in agent.skills:
        if hasattr(s, "twin"):
            s.twin = twin
    return agent, llm, twin


def run(agent, settings, text):
    events, reasons = [], []
    ctx = build_context(sample_request(text, extras={"role": "admin"}), "tok", settings)
    ctx.on_event = lambda e, d: events.append((e, d))
    ctx.on_reasoning = lambda l, t: reasons.append(t)
    return ctx, events, reasons


async def test_sequential_plan_shows_todo_ticks_off_and_hands_changes_on(settings):
    agent, llm, twin = agent_with(settings, {
        "router": [{"skill": "device_control", "request": "turn on the Desk Lamp and dim it to 30%", "parallel": False, "tasks": [
            {"skill": "device_control", "request": "turn on the Desk Lamp and dim it to 30%"},
            {"skill": "routines", "request": "save this as a routine called Cinema"},
            {"skill": "knowledge", "request": "how many rooms are on this floor?"}]}],
        "device_plan": [{"result": "OK", "steps": [{"devices": ["Desk Lamp"], "request": "turn on and dim to 30%"}], "options": []}],
        "action_select": [{"actions": [{"action": "switch.on", "change": "set", "value": ""}, {"action": "switchLevel.setLevel", "change": "set", "value": "30"}]}],
        "routines": [{"action": "save", "routine": "", "name": "Cinema"}],
        "knowledge": [{"reply": "**29 rooms**.", "sources": [1], "follow_ups": []}],
    })
    ctx, events, reasons = run(agent, settings, "Turn on the desk lamp at 30%, save it as Cinema, and tell me how many rooms there are")
    res = await agent.handle(ctx)
    plan = next(d for e, d in events if e == "plan")
    assert [t["title"] for t in plan["tasks"]][1] == "save this as a routine called Cinema" and plan["parallel"] is False
    ticks = [(d["id"], d["status"]) for e, d in events if e == "task"]
    assert ticks == [(1, "running"), (1, "done"), (2, "running"), (2, "done"), (3, "running"), (3, "done")]      # one by one, in order
    assert twin.calls[-1][0] == "routine_save" and twin.calls[-1][1]["actions"][0]["commands"][1]["arguments"] == [30]   # saved what task 1 did
    assert res.status == "success" and res.message.startswith("Done 3 of 3 tasks.") and "1. ✓ **turn on the Desk Lamp" in res.message
    assert "29 rooms" in res.message and res.data["results"] and res.data["sources"]
    assert "Plan: 1) turn on the Desk Lamp" in "".join(reasons)
    assert "save this as a routine" not in res.message.split("\n")[-1].lower() or not res.data.get("save_offer")   # already saved: no offer


async def test_independent_tasks_run_in_parallel(settings):
    agent, llm, _ = agent_with(settings, {
        "router": [{"skill": "knowledge", "request": "how many rooms?", "parallel": True, "tasks": [
            {"skill": "knowledge", "request": "how many rooms?"}, {"skill": "knowledge", "request": "where is Light 3?"}]}],
        "knowledge": [{"reply": "29.", "sources": [], "follow_ups": []}, {"reply": "In the zone.", "sources": [], "follow_ups": []}],
    })
    ctx, events, _ = run(agent, settings, "How many rooms are there, and where is Light 3?")
    t0 = time.monotonic()
    res = await agent.handle(ctx)
    assert time.monotonic() - t0 < 0.35                                       # two 0.2 s lookups at the same time
    ticks = [d["status"] for e, d in events if e == "task"]
    assert ticks[:2] == ["running", "running"]
    assert res.message.startswith("Done 2 of 2 tasks.")


async def test_a_failing_task_does_not_stop_the_others(settings):
    agent, llm, _ = agent_with(settings, {
        "router": [{"skill": "knowledge", "request": "a", "parallel": False, "tasks": [{"skill": "knowledge", "request": "a"}, {"skill": "knowledge", "request": "b"}]}],
        "knowledge": [{"reply": "B answer.", "sources": [], "follow_ups": []}],      # the first call gets this; the second has no script -> fails
    })
    ctx, events, _ = run(agent, settings, "a and b")
    res = await agent.handle(ctx)
    assert [d["status"] for e, d in events if e == "task" and d["status"] != "running"] == ["done", "failed"]
    assert res.status != "error" and "Done 1 of 2 tasks." in res.message and "2. ✕" in res.message


async def test_one_task_is_not_a_plan(settings):
    agent, llm, _ = agent_with(settings, {"router": [{"skill": "knowledge", "request": "how many rooms?", "tasks": [{"skill": "knowledge", "request": "how many rooms?"}]}],
                                          "knowledge": [{"reply": "29 rooms.", "sources": [1], "follow_ups": []}]})
    ctx, events, _ = run(agent, settings, "how many rooms?")
    res = await agent.handle(ctx)
    assert not events and res.message == "29 rooms."
