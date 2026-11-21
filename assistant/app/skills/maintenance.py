"""Skill: device malfunctions, for staff: what is open, acknowledge, start investigating, resolve and record the cause,
and apply a fix (clears the simulated fault). Evidence and explanations come from `diagnostics`; this skill acts.

The model picks the action and the alert from the twin's current alert list (enum), and may fill cause / action text
from what the technician said. The twin keeps the maintenance record and clears the fault."""
from __future__ import annotations

from typing import Any

from app.core.context import TurnContext
from app.core.skill import Skill, SkillResult, register
from app.integrations.twin import TwinClient
from app.skills._staff import enum_schema, need_op, one_of, pick_name

SYSTEM = """You are {bot}, helping a technician work through device alerts.

Open alerts (device id | name | room | level | problem | status | first step):
{alerts}

Actions:
- list: show what is open or what needs attention.
- acknowledge: the technician has seen the alert.
- investigate: the technician is looking into it now.
- resolve: the technician says it is resolved; record "cause" and "action_taken" as they said them (short), else "".
- fix: the technician (or the user) asks to fix / repair / clear it now, or says the repair is done and the device is OK; this records it and returns the device to normal.
Rules: "device_id" = the id from the list the request is about, or "" if unclear. Never invent a cause the technician did not state.

Reply with JSON only: {{"action": "list|acknowledge|investigate|resolve|fix", "device_id": "", "cause": "", "action_taken": ""}}"""


@register
class MaintenanceSkill(Skill):
    name = "maintenance"
    progress_text = "Working the alerts"
    description = "Staff only. Act on device alerts and malfunctions: list open alerts, acknowledge, start investigating, resolve with the cause and action, or fix/repair a faulty device."
    examples = ["what alerts are open?", "acknowledge the AC-04 alert", "I replaced the filter on AC-04, it's resolved", "fix AC-04"]
    capability = "list, acknowledge, resolve and fix device alerts"

    def __init__(self, llm, settings, twin: TwinClient | None = None):
        super().__init__(llm, settings)
        self.twin = twin or TwinClient(settings)

    def is_available(self, ctx: TurnContext) -> bool:
        return ctx.is_staff

    async def run(self, ctx: TurnContext, request: str) -> SkillResult:
        res = await need_op(self.twin, ctx, "alerts")
        if not res.ok:
            return SkillResult("error", "I can't read the alerts right now. Please try again in a moment.", {"error": res.error})
        alerts: list[dict[str, Any]] = res.data.get("alerts", [])
        if not alerts:
            return SkillResult("clarify", "There are no open alerts: every device is healthy.", {"device_ids": []})
        by_id = {a["device_id"]: a for a in alerts}
        schema = enum_schema({"action": {"type": "string", "enum": ["list", "acknowledge", "investigate", "resolve", "fix"]}, "device_id": one_of(list(by_id)),
                              "cause": {"type": "string"}, "action_taken": {"type": "string"}}, ["action", "device_id"])
        lines = "\n".join(f"{a['device_id']} | {a['name']} | {a['room']} | {a['level']} | {a['title']} | {a['status']} | {a.get('first_step') or '-'}" for a in alerts[:30])
        out = await self.llm.complete_json(system=SYSTEM.format(bot=self.settings.bot_name, alerts=lines), user=f"Request: {request}", schema=schema, label="maintenance")
        a, dev = out["action"], by_id.get(out.get("device_id", ""))
        every = [x["device_id"] for x in alerts]
        if a == "list" or not dev:
            if a != "list":
                return SkillResult("clarify", "Which device's alert do you mean? Open: " + pick_name(alerts) + ".", {"device_ids": every})
            return SkillResult("clarify", f"{len(alerts)} open alert(s): " + "; ".join(f"{x['name']} in {x['room']}: {x['title']} ({x['level']}, {x['status']})" for x in alerts[:6]) + (f"; and {len(alerts) - 6} more" if len(alerts) > 6 else "") + ".",
                               {"device_ids": every, "ui": [{"type": "highlight", "ids": every}]})
        title = dev["title"]
        status = {"acknowledge": "acknowledged", "investigate": "investigating", "resolve": "resolved", "fix": "resolved"}[a]
        cause, took = (out.get("cause") or "").strip(), (out.get("action_taken") or "").strip()
        # resolving = fixing: the twin returns the device to normal everywhere (fault cleared, scenario repaired, battery)
        r = await need_op(self.twin, ctx, "alert_update", {"device_id": dev["device_id"], "status": status, "cause": cause or (title if a == "fix" else ""),
                                                            "action": took or ("Fixed from the assistant" if a == "fix" else ""), "alert": title})
        if not r.ok:
            return SkillResult("error", f"I couldn't update the alert on {dev['name']}: {r.error}", {"error": r.error})
        fixed = ((r.data or {}).get("record") or {}).get("fixed") or []
        msg = {"acknowledge": f"Acknowledged: {dev['name']} in {dev['room']} ({title}).", "investigate": f"Marked as investigating: {dev['name']} ({title})."}.get(a, "")
        if a in {"resolve", "fix"}:
            msg = f"Resolved **{dev['name']}** ({title})" + (f", cause: {cause}" if cause else "") + (f", action: {took}" if took else "") + "."
            msg += (f" {', '.join(fixed).capitalize()}: it is back to normal everywhere." if fixed else
                    " Recorded; the alert clears as soon as the device itself reports healthy.")
        return SkillResult("success", msg, {"device_ids": [dev["device_id"]], "ui": [{"type": "focusDevice", "id": dev["device_id"]}]})
