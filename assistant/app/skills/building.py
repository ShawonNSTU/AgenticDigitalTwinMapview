"""Skill: questions about the building and its floor plan, for staff: which rooms exist, what devices are in
each, how many, whether a floor plan is loaded and how to load another. The twin rebuilds this from the live floor
(a newly uploaded plan changes the answer at once). Reading a plan image itself is POST /floorplan/parse."""
from __future__ import annotations

from app.core.context import TurnContext
from app.core.skill import REPLY_FORMAT, REPLY_SCHEMA, Skill, SkillResult, register
from app.devices.matching import _words
from app.integrations.twin import TwinClient
from app.skills._staff import need_op

SYSTEM = """You are {bot}, the assistant of a smart building. Answer the question about the building.

Floor: {title}. {count} rooms, {devices} devices. Floor plan image: {plan}. Entrances: {entrances}.
Rooms (name | devices | what is in it):
{rooms}

Rules:
1. Use ONLY the facts above. If something is not there, say you don't have it.
2. To load or replace the floor plan, the person uploads the plan image in the app's floor setup; the rooms, doors and scale are then read from the image and every device is placed again.
3. At most 4 sentences, plain text, no markdown, no ids.
"""


@register
class BuildingSkill(Skill):
    name = "building"
    progress_text = "Checking the floor"
    description = "Staff only. The building and floor plan: which rooms exist, what devices are in a room, how many devices or rooms, is a floor plan loaded, how to upload one."
    examples = ["which rooms are on this floor?", "what is in the gym room?", "how many devices are there?", "how do I upload a floor plan?"]
    capability = "tell you about the floor, its rooms and where devices are"

    def __init__(self, llm, settings, twin: TwinClient | None = None):
        super().__init__(llm, settings)
        self.twin = twin or TwinClient(settings)

    def is_available(self, ctx: TurnContext) -> bool:
        return ctx.is_staff

    async def run(self, ctx: TurnContext, request: str) -> SkillResult:
        res = await need_op(self.twin, ctx, "layout")
        if not res.ok:
            return SkillResult("error", "I can't read the floor layout right now. Please try again in a moment.", {"error": res.error})
        d = res.data
        req = set(_words(request).split())
        rooms = sorted(d.get("rooms", []), key=lambda r: -len(req & set(_words(r["name"]).split())))   # rooms the question names first
        lines = [f"{r['name']} | {r['devices']} | " + (", ".join(f"{n} {t}" for t, n in r["types"].items()) or "no devices") for r in rooms[:60]]
        system = SYSTEM.format(bot=self.settings.bot_name, title=d.get("title") or "this floor", count=d.get("room_count", 0), devices=d.get("device_count", 0),
                               plan="loaded" if d.get("has_floor_plan_image") else "none", entrances=", ".join(d.get("entrances", [])) or "none listed", rooms="\n".join(lines)) + "\n" + REPLY_FORMAT
        out = await self.llm.complete_json(system=system, user=f"Question: {request}", schema=REPLY_SCHEMA, label="building")
        return SkillResult("clarify", out["reply"].strip() or "I don't have that information.")
