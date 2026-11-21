"""Skill: find devices by type / room / health and explain a fault, for staff (admin, technician).

What the twin knows beyond SmartThings: every device's health and the evidence behind a finding ("the air filter
is clogged: airflow 62%"). The model only ever sees the twin's own lines, and may only pick device ids from the
list it was given, so a highlight or an explanation is always grounded.

Flow: (1) one LLM call picks the intent and the matching device ids from a short list; (2) for "why / what's
wrong" about one device, the twin's insight for it is read and a second LLM call explains it in plain words.
The result carries `ui` actions (highlight, focus, open the device's part) that the web app shows in 3D.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from app.core.context import TurnContext
from app.core.skill import REPLY_FORMAT, Skill, SkillResult, register
from app.devices.matching import _words
from app.integrations.twin import TwinClient

log = logging.getLogger("agent.diagnostics")

MAX_LINES = 40

SELECT_SYSTEM = """You are {bot}, the operations assistant of a smart building shown as a 3D map. Help staff find devices and understand problems.

Devices (id | name | type | room | health | finding):
{lines}

Health words: ok = normal, watch = needs attention soon, fault = broken or about to fail. "problem" means watch or fault.

Rules:
1. Use ONLY the devices above. Never invent ids, rooms or readings.
2. intent "find": the user wants to see or list devices ("show all air conditioners", "which devices have a problem?"). device_ids = every matching id (at most 30). Reply with a short sentence and the count; name up to 6 devices.
3. intent "explain": the user asks why a device is warm/wrong/faulty or how it is doing. device_ids = that one device (the best match). Do not explain yet, the evidence is read next. reply = "".
4. intent "summary": a general question about building health ("how is everything?"). device_ids = the devices that are not ok. Reply in at most 3 sentences.
5. If nothing matches, device_ids = [] and say so in one sentence.
6. Plain text, no markdown. Use device names, with the id in brackets only when it helps (Bedroom AC [AC-04]).

Reply with JSON only: {{"intent": "find"|"explain"|"summary", "device_ids": [<ids from the list>], "reply": "<text>"}}"""

EXPLAIN_SYSTEM = """You are {bot}, the operations assistant of a smart building. Explain this device's state to a technician.

Device: {name} ({type}) in {room}. Health: {health}. Source of readings: {source}.
Parts (name: reading, health{inferred_note}):
{parts}
{finding}
Rules:
1. Use ONLY the facts above. Do not invent causes or readings.
2. Say plainly what is measured and what is inferred (parts marked "inferred" have no sensor).
3. If there is a finding: give its title, the evidence in one sentence and the first check to do.
4. If the device is healthy: say so and mention one or two current readings.
5. At most 5 sentences, plain text, no markdown, times as HH:MM.
"""

SELECT_SCHEMA_BASE: dict[str, Any] = {
    "type": "object",
    "properties": {
        "intent": {"type": "string", "enum": ["find", "explain", "summary"]},
        "device_ids": {"type": "array", "items": {"type": "string"}},
        "reply": {"type": "string"},
    },
    "required": ["intent", "device_ids", "reply"],
}
REPLY_SCHEMA: dict[str, Any] = {"type": "object", "properties": {"reply": {"type": "string"}}, "required": ["reply"]}


def _line(d: dict[str, Any]) -> str:
    f = f" | {d['finding']}" if d.get("finding") else ""
    return f"{d['id']} | {d.get('name', '')} | {d.get('type', '')} | {d.get('room_name') or d.get('room', '')} | {d.get('health', 'ok')}{f}"


def _shortlist(request: str, devices: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    """Every device that is not ok, every id named in the request, then the best word matches, up to `limit`."""
    if len(devices) <= limit:
        return devices
    req = set(_words(request).split())
    named = {m.upper() for m in re.findall(r"\b[A-Za-z]{1,4}-\d{1,3}\b", request)}

    def score(d: dict[str, Any]) -> tuple[int, int, int]:
        words = set(_words(f"{d['id']} {d.get('name', '')} {d.get('type', '')} {d.get('room_name', '')} {d.get('health', '')}").split())
        return (1 if d["id"].upper() in named else 0, 1 if d.get("health", "ok") != "ok" else 0, len(req & words))

    ranked = sorted(devices, key=lambda d: score(d), reverse=True)
    return ranked[:limit]


@register
class DiagnosticsSkill(Skill):
    name = "diagnostics"
    progress_text = "Checking the building"
    description = (
        "Staff only. Find devices by type, room or health on the whole floor/building, show them on the 3D map, "
        "and explain why a device has a problem (faults, filters, refrigerant, readings, evidence)."
    )
    examples = [
        "show all air conditioners with a problem",
        "what's wrong with AC-04?",
        "which devices are not healthy?",
        "why is the bedroom warm?",
    ]
    capability = "find devices and faults on the whole floor and explain what is wrong"

    def __init__(self, llm, settings, twin: TwinClient | None = None):
        super().__init__(llm, settings)
        self.twin = twin or TwinClient(settings)

    def is_available(self, ctx: TurnContext) -> bool:
        return self.settings.diagnostics_enabled and ctx.is_staff

    async def run(self, ctx: TurnContext, request: str) -> SkillResult:
        token = ctx.bearer_token
        floor = await self.twin.floor(token)
        if not floor.ok:
            return SkillResult("error", "I can't read the building's health right now. Please try again in a moment.", {"error": floor.error})
        rooms = {r.get("id"): r.get("name") for r in floor.data.get("rooms", [])}
        devices = [{**d, "room_name": rooms.get(d.get("room"), d.get("room"))} for d in floor.data.get("devices", []) if d.get("id")]
        if not devices:
            return SkillResult("clarify", "There are no devices on this floor yet.")
        by_id = {d["id"]: d for d in devices}

        listed = _shortlist(request, devices, MAX_LINES)
        ids = [d["id"] for d in listed]
        schema = {**SELECT_SCHEMA_BASE, "properties": {**SELECT_SCHEMA_BASE["properties"],
                  "device_ids": {"type": "array", "items": {"type": "string", "enum": ids}}}}
        system = SELECT_SYSTEM.format(bot=self.settings.bot_name, lines="\n".join(_line(d) for d in listed))
        out = await self.llm.complete_json(system=system, user=f"Request: {request}", schema=schema, label="diagnostics")
        picked = [i for i in dict.fromkeys(out.get("device_ids", [])) if i in by_id]
        intent = out["intent"]
        data: dict[str, Any] = {"device_ids": picked, "intent": intent, "time": floor.data.get("time")}

        if intent == "explain" and picked:
            ins = await self.twin.insight(picked[0], token)
            if not ins.ok:
                return SkillResult("error", f"I couldn't read the details of {by_id[picked[0]].get('name', picked[0])} right now.", {**data, "error": ins.error})
            d = ins.data
            parts = d.get("parts") or []
            finding = d.get("finding")
            fin_text = ""
            if finding:
                steps = "; ".join(str(s.get("t")) for s in (finding.get("steps") or [])[:3])
                fin_text = (f"\nFinding ({finding.get('lvl', '')}): {finding.get('title', '')}. {finding.get('conf', '')}.\n"
                            f"Evidence: {'; '.join(finding.get('ev') or [])}\nGuided steps: {steps}\n")
            system = EXPLAIN_SYSTEM.format(
                bot=self.settings.bot_name, name=d.get("name", picked[0]), type=d.get("type", ""), room=d.get("room_name") or d.get("room", ""),
                health=d.get("health", "ok"), source=d.get("source", "simulator"), inferred_note=", inferred = no sensor",
                parts="\n".join(f"- {p.get('name')}: {p.get('value')}, {p.get('health')}{' (inferred)' if p.get('inferred') else ''}" for p in parts[:14]) or "- no parts reported",
                finding=fin_text,
            ) + "\n" + REPLY_FORMAT
            ans = await self.llm.complete_json(system=system, user=f"Question: {request}", schema=REPLY_SCHEMA, label="diagnostics_explain")
            first = ((finding or {}).get("steps") or [{}])[0].get("p")
            data["ui"] = [{"type": "openDevice", "id": picked[0], **({"part": first} if first else {})}]
            data["finding"] = (finding or {}).get("title")
            return SkillResult("clarify", ans["reply"].strip() or "I have no more details on that device.", data)

        if picked:
            data["ui"] = [{"type": "highlight", "ids": picked}] + ([{"type": "focusDevice", "id": picked[0]}] if len(picked) == 1 else [])
        else:
            data["ui"] = [{"type": "clearHighlight"}]
        reply = (out.get("reply") or "").strip() or (f"Found {len(picked)} device(s)." if picked else "I couldn't match that to any device.")
        return SkillResult("clarify", reply, data)
