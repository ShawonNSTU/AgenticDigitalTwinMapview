import asyncio
from app.tools import run_tool
from app import agent


def run(coro):
    return asyncio.run(coro)


def test_search_highlights(platform):
    out, ev = run(run_tool("search_devices", {"query": "faulty air conditioner"}, platform))
    assert out["count"] == 1
    assert ev == [("ui_action", {"type": "highlight", "ids": ["AC-05"], "reason": "faulty air conditioner"})]


def test_open_selects_device(platform):
    _, ev = run(run_tool("show_on_map", {"action": "open", "device_ids": ["AC-05"], "part": "filter"}, platform))
    assert ("ui_action", {"type": "openDevice", "id": "AC-05", "part": "filter"}) in ev
    assert ("select", {"id": "AC-05"}) in ev


def test_open_needs_id(platform):
    out, ev = run(run_tool("show_on_map", {"action": "open"}, platform))
    assert "error" in out and ev == []


def test_unlock_requires_confirmation(platform):
    out, ev = run(run_tool("control_device", {"device_id": "LK-01", "command": "unlock"}, platform))
    assert out["needsConfirmation"] and "instruction" in out and ev == []


def test_floor_summary_lists_problems(platform):
    out, _ = run(run_tool("get_floor_summary", {}, platform))
    assert {d["id"] for d in out["not_healthy"]} == {"AC-04", "AC-05"}
    assert out["not_healthy"][0]["finding"] is None or isinstance(out["not_healthy"][0]["finding"], str)


def test_demo_mode_explains_single_device(platform):
    async def collect():
        return [e async for e in agent.run_demo([{"role": "user", "content": "what's wrong with AC-05"}], platform)]
    events = run(collect())
    kinds = [k for k, _ in events]
    assert kinds[:2] == ["tool", "ui_action"] and "select" in kinds
    assert any(k == "text" and "Airflow blocked" in d["text"] for k, d in events)
