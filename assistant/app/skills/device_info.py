"""Skill: answer questions ABOUT the devices (what exists, counts, what a device/feature does).

Live state ("is it on?", "what brightness?") is handled by device_status."""
from __future__ import annotations

from app.core.context import TurnContext
from app.core.skill import ReplySkill, register
from app.devices.catalog import build_actions, device_line
from app.devices.matching import exact_matches, shortlist

SYSTEM = """You are {bot}, an assistant in a smart building with SmartThings devices. Answer the user's question about the devices here.

Devices ({count} in total; name: what it can control):
{devices}
{details}
Rules:
1. Use ONLY the devices and features listed above. If the answer is not there, say you don't have that information.
2. Current values (on/off, brightness, position) are not listed here. If asked, say you can check them when the user asks about that device's status.
3. For "how many" questions, count from the list. Devices of the same kind (e.g. several ACs) are one device type.
4. Be brief: at most 3 sentences, plain text, no markdown. Never mention device IDs.
"""


@register
class DeviceInfoSkill(ReplySkill):
    name = "device_info"
    progress_text = "Checking devices"
    description = "Which/how many devices exist, what a device or feature can do, which modes it has. Not current state."
    examples = ["how many lights are there?", "what can the Aqara Roller Shade Controller do?", "what does the dimmer do?"]
    capability = "tell you about the devices and what they can do"

    def is_available(self, ctx: TurnContext) -> bool:
        return not ctx.extras.get('role') and bool(ctx.devices)

    def build_prompt(self, ctx: TurnContext, request: str) -> tuple[str, str]:
        listed = shortlist(request, ctx.devices, self.settings.max_device_candidates)
        details = ""
        for d in exact_matches(request, ctx.devices)[:2]:  # full option lists only for named devices
            details += f"\nDetails of {d.name}:\n" + "\n".join(a.describe() for a in build_actions(d)) + "\n"
        system = SYSTEM.format(
            bot=self.settings.bot_name,
            count=len(ctx.devices),
            devices="\n".join(device_line(d) for d in listed),
            details=details,
        )
        return system, f"Question: {request}"
