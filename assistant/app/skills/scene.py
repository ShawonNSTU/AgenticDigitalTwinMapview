"""Skill: drive the 3D view and the simulation, for staff: show / focus / open a device and its parts, trace the
refrigerant circuit, switch layers, reset the camera, change the demo scenario or the simulated time.

The model picks an action and device ids from the twin's own list; the web app shows the result in the 3D renderer.
"""
from __future__ import annotations

from typing import Any

from app.core.context import TurnContext
from app.core.skill import Skill, SkillResult, register
from app.integrations.twin import TwinClient
from app.skills._staff import enum_schema, need_op, one_of
from app.skills.diagnostics import MAX_LINES, _line, _shortlist

SYSTEM = """You are {bot}, controlling the 3D map of a smart building for staff.

Devices (id | name | type | room | health | finding):
{lines}

Actions:
- highlight: light up devices. device_ids = every device meant.
- focus: fly the camera to ONE device.
- open: open ONE device to show its internal parts (part = a part key such as filter, coil, comp, lp if the user names one, else "").
- trace: show the refrigerant circuit from ONE indoor unit.
- clear: remove highlights. reset: reset the camera.
- layer: show/hide a map layer (devices, piping, names, ids, temperature); "on" true or false.
- scenario: switch the demo scenario to normal, filter, refrig or washer.
- time: move the simulated clock to "time" hours (6 to 22, e.g. 14.5 = 14:30).
Rules: use ONLY the ids above; leave unused fields empty / false / 0.

Reply with JSON only: {{"action": "...", "device_ids": [...], "part": "", "layer": "", "on": true, "scenario": "", "time": 0}}"""

ACTIONS = ["highlight", "focus", "open", "trace", "clear", "reset", "layer", "scenario", "time"]


@register
class SceneSkill(Skill):
    name = "scene"
    progress_text = "Updating the 3D view"
    description = "Staff only. Control the 3D map: show/highlight/focus/open a device, trace the refrigerant pipes, toggle layers (names, ids, piping, temperature), reset the camera, change the demo scenario or the time of day."
    examples = ["show AC-04 on the map", "open the compressor of the outdoor unit", "switch to the refrigerant scenario", "move the time to 14:30"]
    capability = "drive the 3D map and the simulation"

    def __init__(self, llm, settings, twin: TwinClient | None = None):
        super().__init__(llm, settings)
        self.twin = twin or TwinClient(settings)

    def is_available(self, ctx: TurnContext) -> bool:
        return ctx.is_staff

    async def run(self, ctx: TurnContext, request: str) -> SkillResult:
        floor = await self.twin.floor(ctx.bearer_token)
        if not floor.ok:
            return SkillResult("error", "I can't read the map right now. Please try again in a moment.", {"error": floor.error})
        rooms = {r.get("id"): r.get("name") for r in floor.data.get("rooms", [])}
        devices = [{**d, "room_name": rooms.get(d.get("room"), d.get("room"))} for d in floor.data.get("devices", []) if d.get("id")]
        listed = _shortlist(request, devices, MAX_LINES)
        ids = [d["id"] for d in listed]
        schema = enum_schema({
            "action": {"type": "string", "enum": ACTIONS}, "device_ids": {"type": "array", "items": {"type": "string", "enum": ids}},
            "part": {"type": "string"}, "layer": one_of(["devices", "piping", "names", "ids", "temperature"]), "on": {"type": "boolean"},
            "scenario": one_of(["normal", "filter", "refrig", "washer"]), "time": {"type": "number"}}, ["action"])
        out = await self.llm.complete_json(system=SYSTEM.format(bot=self.settings.bot_name, lines="\n".join(_line(d) for d in listed)),
                                           user=f"Request: {request}", schema=schema, label="scene")
        a, picked = out["action"], [i for i in dict.fromkeys(out.get("device_ids", [])) if i in ids]
        by_id = {d["id"]: d for d in devices}
        name = lambda i: by_id[i].get("name", i)  # noqa: E731
        ui: list[dict[str, Any]] = []
        data: dict[str, Any] = {"device_ids": picked}
        if a == "highlight" and picked:
            ui, msg = [{"type": "highlight", "ids": picked}], f"Highlighted {len(picked)} device(s) on the map."
        elif a in {"focus", "open", "trace"} and picked:
            t = {"focus": {"type": "focusDevice", "id": picked[0]}, "open": {"type": "openDevice", "id": picked[0], **({"part": out["part"]} if out.get("part") else {})},
                 "trace": {"type": "trace", "from": picked[0]}}[a]
            ui = [t]
            msg = {"focus": f"Flying to {name(picked[0])}.", "open": f"Opened {name(picked[0])} to show its parts.", "trace": f"Tracing the refrigerant circuit from {name(picked[0])}."}[a]
        elif a == "clear":
            ui, msg = [{"type": "clearHighlight"}], "Highlights cleared."
        elif a == "reset":
            ui, msg = [{"type": "resetView"}], "View reset."
        elif a == "layer" and out.get("layer"):
            on = out.get("on", True)
            ui, msg = [{"type": "setLayer", "layer": out["layer"], "on": on}], f"{'Showing' if on else 'Hiding'} the {out['layer']} layer."
        elif a in {"scenario", "time"}:
            payload = {"scenario": out["scenario"]} if a == "scenario" and out.get("scenario") else {"time": float(out["time"])} if a == "time" else {}
            if not payload:
                return SkillResult("clarify", "Which scenario would you like: normal, filter, refrig or washer?")
            res = await need_op(self.twin, ctx, "sim", payload)
            if not res.ok:
                return SkillResult("error", f"I couldn't change the simulation: {res.error}", {"error": res.error})
            h = res.data.get("time", 0)
            msg = f"Scenario is now {res.data.get('scenario')}." if a == "scenario" else f"The simulated time is {int(h):02d}:{int(round((h % 1) * 60)):02d}."
        else:
            return SkillResult("clarify", "Which device or what should I show on the map?")
        data["ui"] = ui
        return SkillResult("success", msg, data)
