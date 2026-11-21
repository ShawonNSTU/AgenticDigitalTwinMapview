"""Skill: help visitors with places, directions and venue info.

Knowledge comes ONLY from data (never from the model's memory):
  * the file at LOCATION_DATA_PATH (default data/locations.json, see data/locations.example.json)
  * optional per-request `location_context` in the /control body (same shape; overrides the file)

Shape:
  {"venue": "...", "summary": "...", "current_location": "...",
   "places": [{"name": "...", "floor": "...", "description": "...", "directions": "...", "keywords": ["..."]}],
   "faq": [{"q": "...", "a": "..."}]}
Only the few entries most related to the question are put in the prompt.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from app.core.context import TurnContext
from app.core.skill import ReplySkill, register

log = logging.getLogger("agent.skills.location")

MAX_ENTRIES = 6

SYSTEM = """You are {bot}, helping visitors find their way around {venue}.

Venue information:
{info}

Rules:
1. Answer ONLY from the venue information above. If it is not there, say you don't have that information and suggest asking the staff.
2. When asked how to get somewhere, give the directions from the information step by step.
3. At most 3 sentences, plain text, no markdown.
"""


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) > 2}


def _place_line(p: dict[str, Any]) -> str:
    parts = [f"Place: {p.get('name', '?')}"]
    for key in ("floor", "description", "directions", "hours"):
        if p.get(key):
            parts.append(f"{key.capitalize()}: {p[key]}")
    return "- " + " | ".join(parts)


@register
class LocationSkill(ReplySkill):
    name = "location"
    progress_text = "Finding the way"
    description = "Places, directions and facilities in the venue: where something is, how to get there, floors, opening hours."
    examples = ["where is the restroom?", "how do I get to the TV zone?", "which floor is the cafe on?"]
    capability = "help you find places and directions in the venue"
    fallback_reply = "Sorry, I don't have that location information. Please ask our staff."

    _file_cache: dict[str, Any] | None = None

    def _file_data(self) -> dict[str, Any]:
        if self._file_cache is None:
            path = self.settings.location_data_path
            try:
                self._file_cache = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
            except (OSError, json.JSONDecodeError) as exc:
                log.error("cannot read %s: %s", path, exc)
                self._file_cache = {}
        return self._file_cache

    def data(self, ctx: TurnContext) -> dict[str, Any]:
        merged = dict(self._file_data())
        merged.update(ctx.extras.get("location_context") or {})
        return merged

    def is_available(self, ctx: TurnContext) -> bool:
        if not self.settings.location_skill_enabled:  # off for now: location questions go to the room API later
            return False
        if ctx.extras.get("role"):  # in the digital twin, the knowledge graph (live floor) answers places and rooms
            return False
        d = self.data(ctx)
        return bool(d.get("places") or d.get("faq") or d.get("summary"))

    def build_prompt(self, ctx: TurnContext, request: str) -> tuple[str, str]:
        d = self.data(ctx)
        q = _words(request)
        entries: list[tuple[int, str]] = []
        for p in d.get("places", []):
            text = " ".join(str(v) for v in p.values())
            entries.append((len(q & _words(text)), _place_line(p)))
        for f in d.get("faq", []):
            entries.append((len(q & _words(f"{f.get('q', '')} {f.get('a', '')}")), f"- Q: {f.get('q')} A: {f.get('a')}"))
        entries.sort(key=lambda e: -e[0])  # stable: keeps file order on ties
        lines = [line for _, line in entries[:MAX_ENTRIES]]
        if d.get("summary"):
            lines.insert(0, f"- About: {d['summary']}")
        if d.get("current_location"):
            lines.insert(0, f"- The visitor is currently at: {d['current_location']}")

        system = SYSTEM.format(
            bot=self.settings.bot_name,
            venue=d.get("venue") or "the venue",
            info="\n".join(lines) or "- (no information)",
        )
        return system, f"Question: {request}"
