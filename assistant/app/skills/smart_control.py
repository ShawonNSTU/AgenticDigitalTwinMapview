"""Skill: reach a GOAL with the devices, thinking about their current state.

For requests that are not one explicit command: feelings and goals ("I'm cold", "it's too bright", "make it cosy",
"get the room ready for a presentation"), exceptions ("turn everything off except the desk lamp") and conditions
("if the shade is closed, open it halfway"). Steps:
  1. pick the devices that matter (the room the user names, else the most relevant ones),
  2. read their LIVE state (fresh /status through the twin),
  3. the model thinks (streamed to the UI as reasoning) and proposes the changes, each with a reason, skipping
     anything already right,
  4. code validates every change against the device's own command catalog (closed options, numeric ranges),
     merges each device's commands into one call and sends them (concurrently),
  5. the reply lists what changed and why, and what was left alone.
Nothing the model writes is sent raw; an unknown device or action is dropped and reported.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from app.core.context import Device, TurnContext
from app.core.skill import Skill, SkillResult, register
from app.devices.catalog import Action, ValueProblem, build_actions
from app.devices.matching import _words, shortlist
from app.devices.state import read_states
from app.integrations.smartthings import SmartThingsClient

log = logging.getLogger("agent.smart_control")

SYSTEM = """You are {bot}, controlling smart devices to reach what the user wants. Think about the CURRENT state first.

Devices (name | room | what it is | current state | actions: id = what it does, allowed values):
{devices}
{guide}
How to decide:
- Comfort: "cold" -> raise the AC set point 1-2 °C or switch the AC to heat/off; "hot" -> lower it 1-2 °C / cool. Never outside the allowed range.
- Light: "too bright" -> lower brightness 20-40 points or close the shade; "dark" -> raise it; "cosy/relax/movie" -> warm white (2200-3000 K), low brightness (10-30%); "focus/work/presentation" -> cool white (4000-5000 K), 80-100%.
- Exceptions ("everything except X") and conditions ("if ...") are applied exactly, using the current state.
- Skip a device that is already as wanted. Change as little as needed. Never change locks.
- People name things by what they are ("the window", "the curtain", "the ceiling light"): use "what it is" to find the device.
- Follow the PURPOSE. If the literal words conflict with what the person wants to achieve (e.g. "close the curtain" but they want to see outside), do what achieves the purpose and say so in "reasoning".
- Use the room guide when it applies.
- If the request is too vague to act safely, return no steps and ask one short question in "question".

Reply with JSON only:
{{"reasoning": "<1-3 sentences: what the user wants and what you will change>",
  "steps": [{{"device": "<exact name>", "action": "<action id of that device>", "value": "<value or empty>", "why": "<few words>"}}],
  "question": "<empty, or one question if you cannot act>"}}"""


def _state_text(state) -> str:
    if state.online is False:
        return "OFFLINE"
    parts = [f"{k} {v}" for k, v in state.readings()] if state.components is not None else []
    return ", ".join(parts[:6]) or "unknown"


@register
class SmartControlSkill(Skill):
    name = "smart_control"
    progress_text = "Thinking it through"
    description = ("Goals and feelings rather than one exact command: \"I'm cold\", \"too bright\", \"make it cosy\", \"get ready for a meeting\", "
                   "\"everything off except the desk lamp\", conditions (\"if the shade is closed ...\"). Reads current state, decides the changes.")
    examples = ["I'm feeling cold", "it's too bright in here", "turn off everything except the desk lamp", "get the room ready for a presentation"]
    capability = "work out what to change from how you feel or what you want to do"

    def __init__(self, llm, settings, st: SmartThingsClient | None = None):
        super().__init__(llm, settings)
        self.st = st or SmartThingsClient(settings)

    def is_available(self, ctx: TurnContext) -> bool:
        return any(build_actions(d) for d in ctx.devices)

    def _candidates(self, ctx: TurnContext, request: str) -> list[Device]:
        controllable = [d for d in ctx.devices if build_actions(d)]
        req = _words(request)
        rooms = {d.room for d in controllable if d.room and _words(d.room).strip() and _words(d.room) in req}
        if rooms:
            controllable = [d for d in controllable if d.room in rooms]
        if len(controllable) <= 20:
            return controllable
        req_w = set(req.split())
        scored = sorted(controllable, key=lambda d: -len(req_w & set(_words(f"{d.name} {d.room or ''} {d.about}").split())))
        return scored[:20]

    async def run(self, ctx: TurnContext, request: str) -> SkillResult:
        devices = self._candidates(ctx, request)
        if not devices:
            return SkillResult("clarify", "I don't see any device I can change for that. Which room or device do you mean?")
        ctx.progress("smart_control.read", f"Reading {len(devices)} devices")
        states = {s.device.id: s for s in await read_states(self.st, devices, ctx.bearer_token, health=False)}
        actions = {d.id: {a.id: a for a in build_actions(d)} for d in devices}
        lines = []
        for d in devices:
            acts = "; ".join(a.describe()[2:] for a in actions[d.id].values() if a.capability != "lock")
            lines.append(f"- {d.name} | {d.room or '-'} | {(d.about or '-')[:220]} | {_state_text(states[d.id])} | {acts}")
        names = [d.name for d in devices]
        all_ids = sorted({a for m in actions.values() for a in m})
        schema = {"type": "object", "properties": {
            "reasoning": {"type": "string"},
            "steps": {"type": "array", "items": {"type": "object", "properties": {
                "device": {"type": "string", "enum": names}, "action": {"type": "string", "enum": all_ids},
                "value": {"type": "string"}, "why": {"type": "string"}}, "required": ["device", "action", "value", "why"]}},
            "question": {"type": "string"}}, "required": ["reasoning", "steps", "question"]}
        ctx.progress("smart_control.plan", "Deciding what to change")
        guide = [str(g) for g in ctx.extras.get("room_guide") or []][:8]
        guide_text = ("\nRoom guide:\n" + "\n".join(f"- {g}" for g in guide) + "\n") if guide else ""
        out = await self.llm.complete_json(system=SYSTEM.format(bot=self.settings.bot_name, devices="\n".join(lines), guide=guide_text),
                                           user=f"Request: {request}", schema=schema, label="smart_control")
        if out.get("reasoning"):
            ctx.reason(out["reasoning"].strip(), "plan")
        by_name = {d.name: d for d in devices}
        plan: dict[str, list[tuple[Action, list[Any], str, str]]] = {}
        dropped: list[str] = []
        for st in out.get("steps") or []:
            d = by_name.get(st.get("device", ""))
            a = actions.get(d.id, {}).get(st.get("action", "")) if d else None
            if not d or not a or a.capability == "lock":
                dropped.append(f"{st.get('device')}: {st.get('action')} is not possible")
                continue
            try:
                args, shown = a.resolve(st.get("value"))
            except ValueProblem as exc:
                dropped.append(f"{d.name}: {exc}")
                continue
            plan.setdefault(d.id, []).append((a, args, shown, (st.get("why") or "").strip()))
        if not plan:
            q = (out.get("question") or "").strip()
            if q:
                return SkillResult("clarify", q)
            return SkillResult("clarify", "Everything already looks right, so I didn't change anything." + (f" ({'; '.join(dropped)})" if dropped else ""))

        ctx.progress("smart_control.send", f"Changing {len(plan)} device(s)")

        async def send(dev_id: str):
            cmds = [a.build(args) for a, args, _, _ in plan[dev_id]]
            return dev_id, cmds, await self.st.execute(dev_id, cmds, ctx.bearer_token)

        sent = await asyncio.gather(*(send(i) for i in plan))
        results, lines_ok, lines_bad = [], [], []
        dev = {d.id: d for d in devices}
        for dev_id, cmds, res in sent:
            d = dev[dev_id]
            what = ", ".join(f"{a.label}{f' {shown}' if shown else ''}" for a, _, shown, _ in plan[dev_id])
            why = "; ".join(dict.fromkeys(w for *_, w in plan[dev_id] if w))
            results.append({"device_id": dev_id, "device_name": d.name, "command_generated": {"commands": cmds},
                            "api_result": res.as_dict(), "status": "success" if res.ok else "error"})
            (lines_ok if res.ok else lines_bad).append(f"- **{d.name}**: {what}" + (f" ({why})" if why and res.ok else "") + ("" if res.ok else f": failed ({res.error})"))
        msg = ("Done! " if lines_ok else "") + (out.get("reasoning") or "").strip().split(". ")[0].rstrip(".") + "."
        msg = msg if lines_ok else "I couldn't make those changes."
        body = "\n".join(lines_ok + lines_bad)
        if dropped:
            body += "\n\nLeft alone: " + "; ".join(dropped)
        status = "success" if lines_ok else "error"
        return SkillResult(status, f"{msg}\n{body}", {"results": results, "plan_reasoning": out.get("reasoning", "")})
