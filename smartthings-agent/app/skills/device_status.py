"""Skill: answer questions about the CURRENT state of devices ("is the Desk Lamp on?",
"what's the shade position?", "which lights are on?").

Pipeline:
  1. targets - exact-name fast path, else the LLM picks device names (enum) from a shortlist
  2. read    - code fetches /status and /health fresh for those devices (no cache)
  3. answer  - the LLM writes one short reply from the readings only. Code builds the readings
               (app/devices/state.py), so the model never sees raw status JSON or device IDs.
If no status could be read at all, the reply comes from a template and the LLM is not called.
"""
from __future__ import annotations

import logging
import re

from app.core.context import Device, TurnContext
from app.core.skill import REPLY_FORMAT, REPLY_SCHEMA, Skill, SkillResult, register
from app.devices.catalog import device_line
from app.devices.matching import exact_matches, shortlist
from app.devices.state import read_states
from app.integrations.smartthings import SmartThingsClient

log = logging.getLogger("agent.skills.device_status")

OK, NONE = "OK", "NONE"

# Words that suggest the question covers more than the device(s) it names: these skip the fast path.
MULTI_HINT = re.compile(r"\b(all|every|any|anything|which|what's on|whats on|other|others|rest|how many|both)\b", re.I)

TARGET_SYSTEM = """Find the devices the user's question is about.

Devices (name: what it can control):
{devices}

Rules:
1. "devices" has the exact names of the devices the question is about.
2. "all", "any", "which" or a plural ("the lights", "what's on?") means every fitting device.
3. If the user names a room, use only devices in that room.
4. If the question means one device but several fit (e.g. "the lamp"), list all of them.
5. If no device fits, set "result" to "NONE". Otherwise set it to "OK".

Reply with JSON only: {{"result": "OK|NONE", "devices": ["<exact name>", ...]}}"""

SYSTEM = """You are {bot}, an assistant in a SmartThings demo experience zone. Answer the user's question about the current state of the devices.

Live readings (just read from the devices):
{states}

Rules:
1. Use ONLY the readings above. Give each value with its unit and the device name.
2. If the reading the user asks about is not listed for a device, say that device doesn't report it. Never guess.
3. If a device is OFFLINE or its status could not be read, say so.
4. For "which" or "how many" questions, count from the readings.
5. Be brief: at most 3 sentences, plain text, no markdown. Never mention device IDs.
"""


@register
class DeviceStatusSkill(Skill):
    name = "device_status"
    progress_text = "Checking status"
    description = "CURRENT state of devices: is it on, current brightness, shade position, temperature, which are on now."
    examples = ["is the Desk Lamp on?", "what's the brightness of Light 1?", "which lights are on?"]
    capability = "check whether devices are on and their current settings"

    def __init__(self, llm, settings):
        super().__init__(llm, settings)
        self.st = SmartThingsClient(settings)

    def is_available(self, ctx: TurnContext) -> bool:
        return bool(ctx.devices)

    async def targets(self, ctx: TurnContext, request: str) -> list[Device]:
        hits = exact_matches(request, ctx.devices)
        if hits and not MULTI_HINT.search(request):
            return hits
        candidates = shortlist(request, ctx.devices, self.settings.max_device_candidates)
        names = [d.name for d in candidates]
        schema = {
            "type": "object",
            "properties": {
                "result": {"type": "string", "enum": [OK, NONE]},
                "devices": {"type": "array", "items": {"type": "string", "enum": names}},
            },
            "required": ["result", "devices"],
        }
        system = TARGET_SYSTEM.format(devices="\n".join(device_line(d) for d in candidates))
        out = await self.llm.complete_json(system=system, user=f"Question: {request}", schema=schema, label="status_targets")
        if out["result"] == NONE:
            return []
        return [d for n in dict.fromkeys(out.get("devices") or []) if (d := ctx.device_by_name(n)) and n in names]

    async def run(self, ctx: TurnContext, request: str) -> SkillResult:
        devices = await self.targets(ctx, request)
        if not devices:
            names = ", ".join(d.name for d in ctx.devices)
            return SkillResult(
                "clarify",
                f"I couldn't find that device in this experience. The available devices are: {names}. Which one would you like me to check?",
                {"options": []},
            )

        limit = self.settings.max_status_devices
        skipped = max(0, len(devices) - limit)
        devices = devices[:limit]
        ctx.progress("device_status.read", "Reading status")
        states = await read_states(self.st, devices, ctx.bearer_token)
        data = {"states": [s.as_dict() for s in states]}
        if len(states) == 1:
            data.update(device_id=states[0].device.id, device_name=states[0].device.name)

        if not any(s.readable for s in states):  # nothing to talk about: no LLM call, no guessing
            offline = [s.device.name for s in states if s.online is False]
            failed = [s for s in states if s.online is not False]
            parts = []
            if offline:
                parts.append(f"{', '.join(offline)} {'is' if len(offline) == 1 else 'are'} offline right now.")
            if failed:
                reasons = ", ".join(dict.fromkeys(s.error or "unknown error" for s in failed))
                parts.append(f"Sorry, I couldn't read the current status of {', '.join(s.device.name for s in failed)} ({reasons}).")
            return SkillResult("clarify", " ".join(parts), data)

        system = SYSTEM.format(bot=self.settings.bot_name, states="\n".join(s.line() for s in states))
        out = await self.llm.complete_json(
            system=system + "\n" + REPLY_FORMAT, user=f"Question: {request}", schema=REPLY_SCHEMA, label=self.name
        )
        reply = out["reply"].strip() or "Sorry, I don't have that information."
        if skipped:
            reply += f" (I checked {limit} devices; {skipped} more were not checked.)"
        return SkillResult("clarify", reply, data)
