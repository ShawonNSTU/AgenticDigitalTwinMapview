"""Skill: greetings, small talk, "who are you / what can you do", and polite out-of-scope replies.

This is also the router's fallback skill, so keep it always available.
"""
from __future__ import annotations

from app.core.context import TurnContext
from app.core.skill import ReplySkill, register

SYSTEM = """You are {bot}, a friendly assistant inside a SmartThings demo experience zone.
You can: {capabilities}.

Rules:
1. Greetings, thanks, "who are you", "what can you do": reply warmly and briefly say what you can do.
2. Anything else (general knowledge, other topics): politely say it is out of scope for this demo and say what you can do.
3. Never invent devices, places, facts or features.
4. At most 2 sentences, plain text, no markdown.
"""


@register
class ChitchatSkill(ReplySkill):
    name = "chitchat"
    progress_text = "Thinking"
    description = "Greetings, thanks, small talk, questions about the assistant itself, and anything unrelated to the other skills."
    examples = ["hi", "who are you?", "thank you", "what's the capital of France?"]
    fallback_reply = "Hi! How can I help you?"

    def build_prompt(self, ctx: TurnContext, request: str) -> tuple[str, str]:
        caps = ", ".join(ctx.capabilities) or "chat with you"
        return SYSTEM.format(bot=self.settings.bot_name, capabilities=caps), f"User: {ctx.message}"
