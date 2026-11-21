"""HTTP request/response models. `/control` stays compatible with the old loungex-chatbot contract."""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class DeviceIn(BaseModel):
    id: str
    name: str
    room: Optional[str] = None
    # What the device is, in people's words ("the left window: a back-lit pane behind the curtain"); used to reason
    about: Optional[str] = None
    # Either a flat list of SmartThings commands or the "actions" format [{"commands": [...]}, ...]
    commands: list[Any] = Field(default_factory=list)
    actions: list[Any] = Field(default_factory=list)


class ControlRequest(BaseModel):
    message: str
    # [{"text"|"content": "...", "role": "user"|"assistant"}, ...] - may include the current message last
    messages: list[dict[str, Any]] = Field(default_factory=list)
    # Legacy device format used by lounge-web ChatBot.tsx
    device_name_id_context: dict[str, str] = Field(default_factory=dict)   # device name -> device id
    device_id_command_context: dict[str, Any] = Field(default_factory=dict)  # device id -> commands
    # Preferred device format (optional; takes precedence when given)
    devices: Optional[list[DeviceIn]] = None
    # Optional data for the location skill (same shape as data/locations.json)
    location_context: Optional[dict[str, Any]] = None
    # Free-form data for future skills; available to skills as ctx.extras
    extras: dict[str, Any] = Field(default_factory=dict)


class ChatbotActionRequest(BaseModel):
    device_id: str
    message: str
    context: dict[str, Any]


class ApiResponse(BaseModel):
    status: str           # "success" | "clarify" | "error"
    message: str          # text to show to the user
    data: Optional[dict[str, Any]] = None
