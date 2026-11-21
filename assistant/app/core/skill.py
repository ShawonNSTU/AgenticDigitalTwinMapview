"""Skill base class + registry.

A skill is one self-contained capability of the agent (device control, location help, ...).
The router only sees each skill's `name`, `description` and `examples`, so keep them short.

To add a skill: create a module in `app/skills/`, subclass `Skill`, decorate with `@register`.
It is discovered automatically (see `load_skills`).
"""
from __future__ import annotations

import importlib
import logging
import pkgutil
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, ClassVar, Literal

from app.config import Settings
from app.core.context import TurnContext
from app.core.llm import LLM

log = logging.getLogger("agent.skills")

Status = Literal["success", "clarify", "error"]


@dataclass
class SkillResult:
    # success = an action was executed; clarify = a reply/question for the user (no action);
    # error = something failed. The text in `message` is always shown to the user.
    status: Status
    message: str
    data: dict[str, Any] = field(default_factory=dict)


class Skill(ABC):
    name: ClassVar[str]
    description: ClassVar[str]          # one line, shown to the router
    examples: ClassVar[list[str]] = []  # 2-4 short user messages, shown to the router
    capability: ClassVar[str] = ""      # user-facing "I can ..." phrase (used by chitchat); "" = hidden
    progress_text: ClassVar[str] = "Working"  # shown live in the chat while this runs; keep it 1-3 words

    def __init__(self, llm: LLM, settings: Settings):
        self.llm = llm
        self.settings = settings

    def is_available(self, ctx: TurnContext) -> bool:
        """Return False to hide this skill from the router for this request."""
        return True

    @abstractmethod
    async def run(self, ctx: TurnContext, request: str) -> SkillResult:
        """`request` is the router's standalone rewrite of the user's message."""


REPLY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"reply": {"type": "string"}},
    "required": ["reply"],
}
REPLY_FORMAT = 'Reply with JSON only: {"reply": "<your answer>"}'


class ReplySkill(Skill):
    """Base for skills that only answer in text. Implement `build_prompt`; the rest is shared."""

    fallback_reply: ClassVar[str] = "Sorry, I don't have that information."

    @abstractmethod
    def build_prompt(self, ctx: TurnContext, request: str) -> tuple[str, str]:
        """Return (system, user). The JSON reply instruction is appended automatically."""

    async def run(self, ctx: TurnContext, request: str) -> SkillResult:
        system, user = self.build_prompt(ctx, request)
        system = system.rstrip() + "\n\n" + REPLY_FORMAT
        out = await self.llm.complete_json(system=system, user=user, schema=REPLY_SCHEMA, label=self.name)
        reply = out["reply"].strip() or self.fallback_reply
        return SkillResult("clarify", reply)


_REGISTRY: dict[str, type[Skill]] = {}


def register(cls: type[Skill]) -> type[Skill]:
    if cls.name in _REGISTRY and _REGISTRY[cls.name] is not cls:
        raise ValueError(f"duplicate skill name: {cls.name}")
    _REGISTRY[cls.name] = cls
    return cls


def load_skills(llm: LLM, settings: Settings) -> list[Skill]:
    """Import every module under app.skills (triggering @register) and instantiate enabled skills."""
    import app.skills as pkg

    for mod in pkgutil.walk_packages(pkg.__path__, prefix=pkg.__name__ + "."):
        importlib.import_module(mod.name)

    enabled = settings.enabled_skills
    unknown = set(enabled) - set(_REGISTRY)
    if unknown:
        log.warning("ENABLED_SKILLS lists unknown skills: %s", ", ".join(sorted(unknown)))
    skills = [cls(llm, settings) for name, cls in _REGISTRY.items() if not enabled or name in enabled]
    log.info("loaded skills: %s", ", ".join(s.name for s in skills))
    return skills
