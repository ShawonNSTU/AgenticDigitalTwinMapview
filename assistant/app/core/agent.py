"""The agent: route the message to a skill, run it, return a SkillResult. No business logic here."""
from __future__ import annotations

import logging

from app.config import Settings
from app.core.context import TurnContext
from app.core.llm import LLM, LLMError, LLMUnavailable
from app.core.router import Router
from app.core.skill import Skill, SkillResult, load_skills

log = logging.getLogger("agent")

BUSY_MESSAGE = "Sorry, I'm having trouble understanding that right now. Could you please try again?"
DOWN_MESSAGE = "The AI model is not reachable right now, so I can't answer. Please try again in a moment."


class Agent:
    def __init__(self, llm: LLM, settings: Settings, skills: list[Skill] | None = None):
        self.settings = settings
        self.skills = skills if skills is not None else load_skills(llm, settings)
        self.router = Router(llm, settings.bot_name)

    def available_skills(self, ctx: TurnContext) -> list[Skill]:
        return [s for s in self.skills if s.is_available(ctx)]

    async def handle(self, ctx: TurnContext) -> SkillResult:
        skills = self.available_skills(ctx)
        if not skills:
            return SkillResult("error", "No skills are enabled on this server.")
        by_name = {s.name: s for s in skills}
        ctx.capabilities = [s.capability for s in skills if s.capability]

        ctx.progress("routing", "Understanding")
        try:
            route = await self.router.route(ctx, skills)
        except LLMUnavailable as exc:
            log.error("router: model unreachable: %s", exc)
            return SkillResult("error", DOWN_MESSAGE, {"error": str(exc), "llm_unavailable": True})
        except LLMError as exc:
            log.error("router failed: %s", exc)
            return SkillResult("error", BUSY_MESSAGE, {"error": str(exc)})

        skill = by_name[route.skill]
        ctx.progress(skill.name, skill.progress_text)
        try:
            result = await skill.run(ctx, route.request)
        except LLMUnavailable as exc:
            log.error("skill %s: model unreachable: %s", skill.name, exc)
            result = SkillResult("error", DOWN_MESSAGE, {"error": str(exc), "llm_unavailable": True})
        except LLMError as exc:
            log.error("skill %s failed: %s", skill.name, exc)
            result = SkillResult("error", BUSY_MESSAGE, {"error": str(exc)})

        result.data.setdefault("skill", skill.name)
        result.data.setdefault("request", route.request)
        return result
