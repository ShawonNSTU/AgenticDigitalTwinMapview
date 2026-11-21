"""Router: picks ONE skill for the latest message and rewrites it as a standalone request.

The router never sees device lists or skill internals - only skill names, one-line descriptions,
a few examples and the trimmed conversation. Downstream skills receive the standalone request,
so they normally do not need the history at all (small, precise prompts).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from app.core.context import TurnContext
from app.core.llm import LLM
from app.core.skill import Skill

log = logging.getLogger("agent.router")

FALLBACK_SKILL = "chitchat"

SYSTEM = """You are the router of {bot}, an assistant in a SmartThings demo experience zone.
Choose the ONE skill that should handle the user's latest message, and rewrite that message as a standalone request.

Skills:
{skills}

Rules:
1. Use the conversation only to understand short follow-ups like "it", "that one", "the blinds one", "yes", "22".
2. "request" is one short English sentence that keeps every device name, number and detail the user gave. Never invent details.
3. If the latest message answers a question the assistant just asked, merge both into one full request (e.g. assistant asked "Which lamp?", user said "Light 1" -> "turn on the Light 1").
4. If no skill fits, choose "{fallback}".

Reply with JSON only: {{"skill": "<skill name>", "request": "<standalone request>"}}"""


@dataclass
class Route:
    skill: str
    request: str


def _skill_lines(skills: list[Skill]) -> str:
    lines = []
    for s in skills:
        ex = "; ".join(f'"{e}"' for e in s.examples[:4])
        lines.append(f"- {s.name}: {s.description}" + (f" Examples: {ex}" if ex else ""))
    return "\n".join(lines)


class Router:
    def __init__(self, llm: LLM, bot_name: str):
        self.llm = llm
        self.bot_name = bot_name

    async def route(self, ctx: TurnContext, skills: list[Skill]) -> Route:
        names = [s.name for s in skills]
        if len(skills) == 1:
            return Route(skill=names[0], request=ctx.message)

        fallback = FALLBACK_SKILL if FALLBACK_SKILL in names else names[0]
        system = SYSTEM.format(bot=self.bot_name, skills=_skill_lines(skills), fallback=fallback)
        convo = ctx.history_text() or "(no previous messages)"
        user = f"Conversation so far:\n{convo}\n\nLatest user message: {ctx.message}"
        schema = {
            "type": "object",
            "properties": {
                "skill": {"type": "string", "enum": names},
                "request": {"type": "string"},
            },
            "required": ["skill", "request"],
        }
        out = await self.llm.complete_json(system=system, user=user, schema=schema, label="router")
        request = (out.get("request") or "").strip() or ctx.message
        log.info("route -> %s | %s", out["skill"], request)
        return Route(skill=out["skill"], request=request)
