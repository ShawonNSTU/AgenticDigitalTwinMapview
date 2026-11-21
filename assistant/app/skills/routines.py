"""Skill: run a routine (a named set of device commands for a room) for staff and for guests.

"movie night", "good night", "make the room comfortable for sleeping". The routines and what each does to each
device type are defined in the twin (web/lib/sim/routines.ts), which also runs them through the same rules as every
other command (real SmartThings devices, zone rules, a guest's pass). The model only chooses routine and room.
"""
from __future__ import annotations

from typing import Any

from app.core.context import TurnContext
from app.core.skill import Skill, SkillResult, register
from app.integrations.twin import TwinClient
from app.skills._staff import enum_schema, need_op, one_of

SYSTEM = """You are {bot}. Choose which routine the user wants for their room.

Routines (id: name, what it does):
{routines}
{rooms}
Rules:
1. "routine" = the id that best fits (movie night, bedtime/sleep/good night, morning/wake up, welcome, focus/work, away/leaving). If none fits, "".
2. {room_rule}
3. "action" = "list" only when the user asks what routines exist; otherwise "run".

Reply with JSON only: {{"action": "run|list", "routine": "<id or empty>", "room": "<room id or empty>"}}"""


@register
class RoutinesSkill(Skill):
    name = "routines"
    progress_text = "Setting the scene"
    description = "Run a routine that sets many devices for a room: movie night, good night, morning, welcome, focus, away."
    examples = ["movie night", "make the room comfortable for sleeping", "what routines are there?"]
    capability = "run routines like movie night or good night"

    def __init__(self, llm, settings, twin: TwinClient | None = None):
        super().__init__(llm, settings)
        self.twin = twin or TwinClient(settings)

    async def run(self, ctx: TurnContext, request: str) -> SkillResult:
        listed = await need_op(self.twin, ctx, "routines")
        if not listed.ok:
            return SkillResult("error", "I can't reach the routines right now. Please try again in a moment.", {"error": listed.error})
        routines = listed.data.get("routines", [])
        rooms = listed.data.get("rooms") or []          # staff: the rooms to choose from; a guest's room is fixed
        by_id = {r["id"]: r for r in routines}
        room_ids = [r["id"] for r in rooms]
        schema = enum_schema({"action": {"type": "string", "enum": ["run", "list"]}, "routine": one_of(list(by_id)),
                              **({"room": one_of(room_ids)} if rooms else {})}, ["action", "routine"] + (["room"] if rooms else []))
        system = SYSTEM.format(
            bot=self.settings.bot_name,
            routines="\n".join(f"- {r['id']}: {r['name']}, {r['about']}" for r in routines),
            rooms=("\nRooms (id: name):\n" + "\n".join(f"- {r['id']}: {r['name']}" for r in rooms) + "\n") if rooms else "",
            room_rule='"room" = the id of the room the user named, or "" if they did not name one.' if rooms else 'Leave "room" out: the routine runs in the guest\'s own room.',
        )
        out = await self.llm.complete_json(system=system, user=f"Request: {request}", schema=schema, label="routines")
        if out["action"] == "list" or not out["routine"]:
            text = "; ".join(f"{r['name']} ({r['about'].lower()})" for r in routines)
            return SkillResult("clarify", f"I can run these routines: {text}. Which one would you like?" if out["action"] == "run" else f"Routines: {text}.", {"routines": list(by_id)})
        room = out.get("room", "")
        if rooms and not room:
            return SkillResult("clarify", f"Which room should I run {by_id[out['routine']]['name']} in?")
        ctx.progress("routines", f"Running {by_id[out['routine']]['name']}")
        res = await need_op(self.twin, ctx, "routine_run", {"routine": out["routine"], "room": room})
        if not res.ok:
            return SkillResult("error", f"I couldn't run {by_id[out['routine']]['name']}: {res.error}", {"error": res.error})
        d = res.data
        results: list[dict[str, Any]] = d.get("results", [])
        if not results:
            return SkillResult("clarify", d.get("note") or "That room has no devices this routine can use.", {"results": []})
        good = [r for r in results if r["ok"]]
        bad = [r for r in results if not r["ok"]]
        msg = f"Done! {d['routine']}" + (f" in {d['room']}" if rooms else "") + (f": {len(good)} device(s) set." if good else ".")
        if good:
            msg = f"Done! {d['routine']}" + (f" in {d['room']}" if rooms else "") + f": {', '.join(r['name'] for r in good[:8])}" + (f" and {len(good) - 8} more" if len(good) > 8 else "") + "."
        if bad:
            msg += " Could not change " + "; ".join(f"{r['name']} ({r.get('error', 'no answer')})" for r in bad[:4]) + "."
        data: dict[str, Any] = {"routine": out["routine"], "results": [
            {"device_id": r["device_id"], "device_name": r["name"], "status": "success" if r["ok"] else "error", "api_result": {"error": r.get("error")}} for r in results]}
        return SkillResult("success" if good else "error", msg, data)
