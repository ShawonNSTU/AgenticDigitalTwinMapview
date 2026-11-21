"""LLM access layer. Every skill talks to the model ONLY through `LLM.complete_json`.

Contract: give a short system prompt, a short user prompt and a JSON schema; get back a dict
that is guaranteed to satisfy the schema, or an `LLMError` is raised.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Protocol

import ollama

from app.config import Settings
from app.core.jsonutil import extract_json, validate

log = logging.getLogger("agent.llm")


class LLMError(RuntimeError):
    """The model could not produce a valid answer after all retries."""


class LLM(Protocol):
    async def complete_json(
        self, *, system: str, user: str, schema: dict[str, Any], label: str
    ) -> dict[str, Any]: ...


def _think_value(raw: str) -> bool | str | None:
    raw = raw.strip().lower()
    if not raw:
        return None
    if raw in {"true", "false"}:
        return raw == "true"
    return raw  # "low" | "medium" | "high"


class OllamaLLM:
    def __init__(self, settings: Settings):
        self.s = settings
        self._client = ollama.AsyncClient(host=settings.ollama_base_url, timeout=settings.llm_timeout_s)
        self._think = _think_value(settings.ollama_think)

    async def complete_json(
        self, *, system: str, user: str, schema: dict[str, Any], label: str
    ) -> dict[str, Any]:
        messages: list[dict[str, str]] = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        last_error = "unknown error"
        for attempt in range(1, self.s.llm_max_retries + 2):
            kwargs: dict[str, Any] = {
                "model": self.s.ollama_model,
                "messages": messages,
                "options": {"temperature": self.s.llm_temperature},
            }
            if self.s.llm_structured_output:
                kwargs["format"] = schema
            if self._think is not None:
                kwargs["think"] = self._think

            log.debug("[%s] attempt %d prompt:\n--- system ---\n%s\n--- user ---\n%s", label, attempt, system, user)
            try:
                resp = await asyncio.wait_for(self._client.chat(**kwargs), timeout=self.s.llm_timeout_s)
            except Exception as exc:  # network / server errors: retry without feedback
                last_error = f"LLM call failed: {exc}"
                log.warning("[%s] attempt %d: %s", label, attempt, last_error)
                continue

            content = (resp.message.content or "").strip()
            log.info("[%s] attempt %d raw: %s", label, attempt, content)
            try:
                obj = extract_json(content)
                errors = validate(obj, schema)
                if errors:
                    raise ValueError("; ".join(errors))
                return obj
            except ValueError as exc:
                last_error = str(exc)
                log.warning("[%s] attempt %d invalid output: %s", label, attempt, last_error)
                # Self-correction: show the model its own output and the exact problem.
                messages = messages[:2] + [
                    {"role": "assistant", "content": content or "(empty)"},
                    {
                        "role": "user",
                        "content": (
                            f"That reply was invalid: {last_error}.\n"
                            f"Reply again with ONLY one JSON object matching this schema:\n"
                            f"{json.dumps(schema)}"
                        ),
                    },
                ]
        raise LLMError(f"[{label}] {last_error}")
