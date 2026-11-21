"""Convert an HTTP request into a TurnContext (devices + trimmed history)."""
from __future__ import annotations

from typing import Any

from app.config import Settings
from app.core.context import Device, Message, TurnContext
from app.rooms.store import attach_rooms, rooms_for
from app.schemas import ControlRequest


def flatten_commands(items: Any) -> list[dict[str, Any]]:
    """Accept command dicts, {"commands": dict|list} action wrappers, or nested lists."""
    out: list[dict[str, Any]] = []
    if isinstance(items, dict):
        if "capability" in items:
            out.append(items)
        elif "commands" in items:
            out.extend(flatten_commands(items["commands"]))
    elif isinstance(items, list):
        for it in items:
            out.extend(flatten_commands(it))
    return out


def build_devices(req: ControlRequest) -> list[Device]:
    if req.devices:
        return [
            Device(id=d.id, name=d.name, room=d.room, commands=flatten_commands(d.commands) + flatten_commands(d.actions))
            for d in req.devices
        ]
    return [
        Device(id=dev_id, name=name, commands=flatten_commands(req.device_id_command_context.get(dev_id, [])))
        for name, dev_id in req.device_name_id_context.items()
    ]


def build_history(raw: list[dict[str, Any]], current: str, settings: Settings) -> list[Message]:
    msgs: list[Message] = []
    for m in raw:
        text = str(m.get("text") or m.get("content") or "").strip()
        role = "assistant" if str(m.get("role", "user")).lower() in {"assistant", "bot", "ai"} else "user"
        if text:
            msgs.append(Message(role, text))
    # the frontend appends the current message to the history; don't show it twice
    if msgs and msgs[-1].role == "user" and msgs[-1].text == current.strip():
        msgs.pop()
    msgs = msgs[-settings.history_max_messages :] if settings.history_max_messages > 0 else []
    limit = settings.history_max_chars
    return [Message(m.role, m.text if len(m.text) <= limit else m.text[: limit - 3] + "...") for m in msgs]


def build_context(req: ControlRequest, bearer_token: str | None, settings: Settings) -> TurnContext:
    extras = dict(req.extras)
    if req.location_context:
        extras["location_context"] = req.location_context
    ctx = TurnContext(
        message=req.message.strip(),
        history=build_history(req.messages, req.message, settings),
        devices=build_devices(req),
        bearer_token=bearer_token,
        extras=extras,
    )
    attach_rooms(ctx, rooms_for(ctx, settings))  # device.room for device answers, when not sent by the frontend
    return ctx
