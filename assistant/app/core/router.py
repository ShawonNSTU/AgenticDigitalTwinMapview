"""Router: picks ONE skill for the latest message and rewrites it as a standalone request.

The router never sees device lists or skill internals - only skill names, one-line descriptions,
a few examples and the trimmed conversation. Downstream skills receive the standalone request,
so they normally do not need the history at all (small, precise prompts).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from app.core.context import TurnContext
from app.core.llm import LLM
from app.core.skill import Skill

log = logging.getLogger("agent.router")

FALLBACK_SKILL = "chitchat"

SYSTEM = """You are the router of {bot}, an assistant in a smart building with SmartThings devices.
Choose the ONE skill that should handle the user's latest message, and rewrite that message as a standalone request.

Skills:
{skills}

Rules:
1. Use the conversation only to understand short follow-ups like "it", "that one", "the blinds one", "yes", "22".
2. "request" is one short English sentence that keeps every device name, number and detail the user gave. Never invent details.
3. If the latest message answers a question the assistant just asked, merge both into one full request (e.g. assistant asked "Which lamp?", user said "Light 1" -> "turn on the Light 1").
4. Feelings, goals, a stated purpose ("because I want to see outside", "so I can read"), things named by what they are instead of a device name ("the window", "the curtain", "the ceiling light"), "except" and "if" requests about devices ("I'm cold", "too bright", "make it cosy") go to "smart_control" when listed; one explicit command ("turn on Light 1") goes to "device_control".
5. Questions (how many, which, where, who, when, what happened, is there) go to "knowledge" when it is listed; requests to change devices go to the control skills.
{extra}6. If no skill fits, choose "{fallback}".
7. SEVERAL TASKS: if the message asks for different kinds of work (e.g. "check the guest in, run movie night and tell me how many rooms there are"), also return "tasks": one item per task, in the order to do them, each with its skill and a standalone request; "skill"/"request" = the first task. Several device changes of the same kind ("turn on Light 1 and dim Light 2") are ONE device_control task, not several. Set "parallel": true only if no task needs the result or the change of another (e.g. two questions); otherwise false. At most 6 tasks.

Reply with JSON only: {{"skill": "<skill name>", "request": "<standalone request>", "tasks": [{{"skill": "...", "request": "..."}}], "parallel": false}}
("tasks" may be left out or empty when there is one task.)"""


EXPERIENCE_RULE = ('5b. "experience": room comfort, energy / cost / savings, a guest\'s arrival ("on my way", "is my room ready", '
                   '"heading out", check-out), predicted failures, sending a technician.\n')


@dataclass
class Task:
    skill: str
    request: str


@dataclass
class Route:
    skill: str
    request: str
    tasks: list[Task] = field(default_factory=list)   # 2+ = a plan the agent works through
    parallel: bool = False


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

        # with the twin's knowledge graph, an unclear question is best answered from what the assistant knows
        fallback = "knowledge" if "knowledge" in names else FALLBACK_SKILL if FALLBACK_SKILL in names else names[0]
        # rules for skills that are only sometimes offered go in only when they are (the prompt stays small)
        extra = EXPERIENCE_RULE if "experience" in names else ""
        system = SYSTEM.format(bot=self.bot_name, skills=_skill_lines(skills), fallback=fallback, extra=extra)
        convo = ctx.history_text() or "(no previous messages)"
        user = f"Conversation so far:\n{convo}\n\nLatest user message: {ctx.message}"
        schema = {
            "type": "object",
            "properties": {
                "skill": {"type": "string", "enum": names},
                "request": {"type": "string"},
                "tasks": {"type": "array", "items": {"type": "object", "properties": {
                    "skill": {"type": "string", "enum": names}, "request": {"type": "string"}}, "required": ["skill", "request"]}},
                "parallel": {"type": "boolean"},
            },
            "required": ["skill", "request"],
        }
        out = await self.llm.complete_json(system=system, user=user, schema=schema, label="router")
        request = (out.get("request") or "").strip() or ctx.message
        tasks = [Task(t["skill"], (t.get("request") or "").strip()) for t in out.get("tasks") or [] if (t.get("request") or "").strip()][:6]
        # a "plan" of one is just the single route
        if len(tasks) < 2:
            tasks = []
        log.info("route -> %s | %s%s", out["skill"], request, f" | plan of {len(tasks)}" if tasks else "")
        return Route(skill=out["skill"], request=request, tasks=tasks, parallel=bool(out.get("parallel")) and bool(tasks))
