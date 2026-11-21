"""Shared fixtures: a scripted fake LLM (validates replies against the schema) and sample devices."""
from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any, Callable

import pytest

from app.config import Settings
from app.core.agent import Agent
from app.core.jsonutil import validate
from app.core.llm import LLMError
from app.normalize import build_devices
from app.schemas import ControlRequest

ROOT = Path(__file__).resolve().parent.parent


class FakeLLM:
    """Answers per prompt label from a script. A value may be a dict or fn(system, user) -> dict."""

    def __init__(self, script: dict[str, list[Any]] | None = None):
        self.script = {k: list(v) for k, v in (script or {}).items()}
        self.calls: list[dict[str, Any]] = []

    async def complete_json(self, *, system: str, user: str, schema: dict[str, Any], label: str) -> dict[str, Any]:
        self.calls.append({"label": label, "system": system, "user": user, "schema": schema})
        queue = self.script.get(label)
        if not queue:
            raise LLMError(f"no scripted reply for {label}")
        reply = queue.pop(0)
        out = reply(system, user) if callable(reply) else reply
        errors = validate(out, schema)
        assert not errors, f"scripted reply for {label} violates schema: {errors}"
        return out

    def labels(self) -> list[str]:
        return [c["label"] for c in self.calls]


def sample_request(message: str = "hi", **kw) -> ControlRequest:
    """The exact payload shape lounge-web ChatBot.tsx sends, built from its device commands file."""
    data = json.loads((ROOT / "data" / "devices.sample.json").read_text())
    devices = data["context"]["devices"]
    return ControlRequest(
        message=message,
        messages=kw.pop("messages", [{"text": message, "role": "user"}]),
        device_name_id_context={d["name"]: d["id"] for d in devices},
        device_id_command_context={d["id"]: d["actions"] for d in devices},
        **kw,
    )


@pytest.fixture
def settings(tmp_path) -> Settings:
    return replace(
        Settings(),
        st_dry_run=True,
        reply_style="template",
        enabled_skills=[],
        location_data_path=ROOT / "data" / "locations.example.json",
        location_skill_enabled=True,
        rooms_data_path=ROOT / "data" / "rooms.example.json",
    )


@pytest.fixture
def devices():
    return build_devices(sample_request())


@pytest.fixture
def make_agent(settings) -> Callable[..., tuple[Agent, FakeLLM]]:
    def _make(script: dict[str, list[Any]] | None = None, **overrides) -> tuple[Agent, FakeLLM]:
        llm = FakeLLM(script)
        return Agent(llm, replace(settings, **overrides)), llm

    return _make
