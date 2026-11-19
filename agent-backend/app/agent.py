"""Claude tool-use loop. Yields SSE events: text, tool, ui_action, select, error, done."""
import json
from collections.abc import AsyncIterator
from typing import Any

from .config import ANTHROPIC_API_KEY, AGENT_MODEL, MAX_TOOL_ROUNDS
from .platform import Platform, PlatformError
from .search import search
from .tools import TOOLS, run_tool

SYSTEM = """You are the operations assistant for a smart-home digital twin shown as a 3D map.
The user sees the map and a side panel. You can search devices, read live insights, control devices and drive the map.

Rules:
- Ground every claim in a tool result. Never invent readings, ids or causes.
- When the user asks to find or show devices, call search_devices so the matches light up on the map.
- When explaining a fault, call get_device_insights, then show_on_map with action "open" and the most relevant part,
  and walk through the evidence and the first guided step. Say clearly when a cause is inferred rather than measured.
- For refrigerant problems use show_on_map "trace" from the affected indoor unit.
- Commands: only use control_device for what the user asked. If the platform says confirmation is needed, ask the user
  in one short sentence and stop. Set confirmed=true only when the user's latest message says yes to that exact action.
- Keep answers short: two to five sentences, device ids in the form AC-04, times as HH:MM."""

Event = tuple[str, dict]


def _summ(name: str, args: dict, result: Any) -> str:
    if isinstance(result, dict) and result.get("error"):
        return f"failed: {result['error']}"
    if name == "search_devices":
        return f"{result['count']} match(es) for \"{args.get('query', '')}\""
    if name == "get_device_insights":
        return f"{result['id']} is {result['health']}"
    if name == "control_device":
        return "done" if result.get("ok") else ("waiting for confirmation" if result.get("needsConfirmation") else "rejected")
    if name == "show_on_map":
        return f"{args.get('action')} {', '.join(args.get('device_ids') or [])}".strip()
    return "ok"


async def run_claude(messages: list[dict], platform: Platform) -> AsyncIterator[Event]:
    from anthropic import AsyncAnthropic

    client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    convo: list[dict] = [{"role": m["role"], "content": m["content"]} for m in messages if m.get("content")]
    for _ in range(MAX_TOOL_ROUNDS):
        resp = await client.messages.create(model=AGENT_MODEL, max_tokens=1024, system=SYSTEM, tools=TOOLS, messages=convo)
        convo.append({"role": "assistant", "content": [b.model_dump(exclude_none=True) for b in resp.content]})
        results = []
        for block in resp.content:
            if block.type == "text" and block.text.strip():
                yield "text", {"text": block.text}
            elif block.type == "tool_use":
                out, events = await run_tool(block.name, dict(block.input), platform)
                yield "tool", {"name": block.name, "summary": _summ(block.name, dict(block.input), out)}
                for e in events:
                    yield e
                results.append({"type": "tool_result", "tool_use_id": block.id, "content": json.dumps(out, default=str)[:12000], "is_error": bool(isinstance(out, dict) and out.get("error"))})
        if resp.stop_reason != "tool_use":
            return
        convo.append({"role": "user", "content": results})
    yield "text", {"text": "I stopped after several steps. Ask me to continue if you need more."}


async def run_demo(messages: list[dict], platform: Platform) -> AsyncIterator[Event]:
    """No API key: rule-based search and explain, so the demo works offline."""
    q = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    try:
        floor = await platform.floor()
    except PlatformError as e:
        yield "error", {"message": str(e)}
        return
    res = search(q, floor)
    ids = [d["id"] for d in res["devices"]]
    yield "tool", {"name": "search_devices", "summary": f"{len(ids)} match(es) (demo mode, no LLM)"}
    if not ids:
        yield "ui_action", {"type": "clearHighlight"}
        yield "text", {"text": "I couldn't match that to any device. Try a device type, a room, a health word like \"fault\", or an id like AC-04."}
        return
    yield "ui_action", {"type": "highlight", "ids": ids, "reason": q}
    asks_why = any(w in q.lower() for w in ("wrong", "why", "problem", "fault", "issue", "explain", "open", "diagnose"))
    if res["understood"]["ids"] or (len(ids) == 1 and asks_why):
        d = await platform.device(ids[0])
        f = d.get("finding")
        part = f["steps"][0]["p"] if f else None
        yield "ui_action", {"type": "openDevice", "id": d["id"], **({"part": part} if part else {})}
        yield "select", {"id": d["id"]}
        if f:
            yield "text", {"text": f"{d['id']} ({d['label']}, {d['room']}): {f['title']}. {f['conf']}.\nEvidence: " + "; ".join(f["ev"]) + f".\nFirst step: {f['steps'][0]['t']}."}
        else:
            yield "text", {"text": f"{d['id']} ({d['label']}, {d['room']}) is {d['health']}. Its parts are open on the map."}
        return
    if len(ids) == 1:
        d = res["devices"][0]
        yield "ui_action", {"type": "focusDevice", "id": d["id"]}
        yield "text", {"text": f"Found {d['id']} ({d['label']}, {d['room']}, {d['health']}). It's highlighted on the map. Ask what's wrong with it to open it."}
        return
    listing = ", ".join(f"{d['id']} ({d['room']}, {d['health']})" for d in res["devices"][:12])
    more = f" and {len(ids) - 12} more" if len(ids) > 12 else ""
    yield "text", {"text": f"Found {len(ids)}: {listing}{more}. They're highlighted on the map."}


async def run(messages: list[dict], platform: Platform) -> AsyncIterator[Event]:
    gen = run_claude(messages, platform) if ANTHROPIC_API_KEY else run_demo(messages, platform)
    try:
        async for e in gen:
            yield e
    except PlatformError as e:
        yield "error", {"message": str(e)}
    except Exception as e:  # surface model/API errors to the chat instead of a dead stream
        yield "error", {"message": f"{type(e).__name__}: {e}"}
    yield "done", {}
