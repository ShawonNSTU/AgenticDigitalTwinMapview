"""Skill: guest check-in, for staff: create a guest pass for a room (link + PIN), list the active passes, withdraw one.

The twin creates and validates the pass (room must be ready for guests, stay at most 31 days); the model only picks
the action, the room (from the twin's room list) and the stay length. The pass link and PIN are in the reply, for
the front desk to hand over."""
from __future__ import annotations

import time
from typing import Any

from app.core.context import TurnContext
from app.core.skill import Skill, SkillResult, register
from app.integrations.twin import TwinClient
from app.skills._staff import enum_schema, need_op, one_of

SYSTEM = """You are {bot}. Front desk request about guest check-in. Choose what to do.

Rooms (id: name):
{rooms}
Active guest passes (number: room, label):
{passes}

Rules:
1. action "create": check a guest in / make a guest link or pass for a room. Needs a room. "hours" = the stay length in hours ("2 nights" = 48, "a day" = 24; default 24). "label" = the guest's name if given, else "". "verify" = false only if the user says no PIN / no verification.
2. action "list": show who is checked in / active passes.
3. action "revoke": check out / withdraw a pass: "pass" = its number from the list.
4. If the room is missing or unclear for create, use room "".

Reply with JSON only: {{"action": "create|list|revoke", "room": "<room id or empty>", "hours": 24, "label": "", "verify": true, "pass": "<number or empty>"}}"""


def _until(ms: float) -> str:
    return time.strftime("%a %H:%M", time.localtime(ms / 1000))


@register
class CheckinSkill(Skill):
    name = "checkin"
    progress_text = "Checking in"
    description = "Staff only. Guest check-in and check-out: create a guest pass (link and PIN) for a room, list who is checked in, withdraw a pass."
    examples = ["check a guest into the SmartThings Experience Zone for 2 nights", "who is checked in?", "check out the guest in the gym room"]
    capability = "check guests in and out"

    def __init__(self, llm, settings, twin: TwinClient | None = None):
        super().__init__(llm, settings)
        self.twin = twin or TwinClient(settings)

    def is_available(self, ctx: TurnContext) -> bool:
        return ctx.is_staff

    async def run(self, ctx: TurnContext, request: str) -> SkillResult:
        layout, passes = await need_op(self.twin, ctx, "layout"), await need_op(self.twin, ctx, "passes")
        if not layout.ok or not passes.ok:
            return SkillResult("error", "I can't reach the check-in system right now. Please try again in a moment.", {"error": layout.error or passes.error})
        rooms = layout.data.get("rooms", [])
        active = passes.data.get("passes", [])
        numbered = {str(i + 1): p for i, p in enumerate(active)}
        schema = enum_schema({"action": {"type": "string", "enum": ["create", "list", "revoke"]}, "room": one_of([r["id"] for r in rooms]), "hours": {"type": "number"},
                              "label": {"type": "string"}, "verify": {"type": "boolean"}, "pass": one_of(list(numbered))}, ["action"])
        system = SYSTEM.format(bot=self.settings.bot_name, rooms="\n".join(f"- {r['id']}: {r['name']}" for r in rooms[:80]),
                               passes="\n".join(f"{n}: {p['room_name']}, {p.get('label') or 'no name'}" for n, p in numbered.items()) or "(none)")
        out = await self.llm.complete_json(system=system, user=f"Request: {request}", schema=schema, label="checkin")
        a = out["action"]
        if a == "list":
            if not active:
                return SkillResult("clarify", "Nobody is checked in right now.", {"passes": []})
            return SkillResult("clarify", "Checked in: " + "; ".join(f"{p['room_name']} ({p.get('label') or 'no name'}, until {_until(p['expires_at'])})" for p in active) + ".", {"passes": [p["token"][:6] for p in active]})
        if a == "revoke":
            p = numbered.get(out.get("pass", ""))
            if not p:
                return SkillResult("clarify", "Which guest should I check out? " + ("; ".join(f"{n}: {q['room_name']} ({q.get('label') or 'no name'})" for n, q in numbered.items()) or "Nobody is checked in."))
            r = await need_op(self.twin, ctx, "pass_revoke", {"token": p["token"]})
            return SkillResult("success", f"Checked out {p.get('label') or 'the guest'} from {p['room_name']}; the link no longer works." if r.ok else f"I couldn't withdraw that pass: {r.error}")
        if not out.get("room"):
            return SkillResult("clarify", "Which room is the guest checking into?")
        r = await need_op(self.twin, ctx, "pass_create", {"room": out["room"], "hours": out.get("hours") or 24, "label": out.get("label", ""), "verify": out.get("verify", True)})
        if not r.ok:
            return SkillResult("error", f"I couldn't check the guest in: {r.error}", {"error": r.error})
        d = r.data
        base = str(ctx.extras.get("public_url") or self.settings.web_public_url).rstrip("/")   # the address staff use
        link = f"{base}{d['path']}"
        msg = f"Checked in{' ' + d['label'] if d.get('label') else ''} to {d['room_name']} until {_until(d['expires_at'])}. Guest link: {link}" + (f" · PIN: {d['pin']}" if d.get("pin") else " (no PIN)") + ". Give the guest the link (a QR code works) and the PIN."
        card = {"kind": "guest_pass", "title": f"Guest pass · {d['room_name']}", "link": link, "pin": d.get("pin"), "room": d["room_name"],
                "until": _until(d["expires_at"]), "label": d.get("label") or ""}
        return SkillResult("success", msg, {"pass_room": d["room"], "card": card})
