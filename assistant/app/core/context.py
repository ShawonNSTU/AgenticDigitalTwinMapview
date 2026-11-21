"""Per-request data passed to the router and to every skill."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class Message:
    role: str  # "user" | "assistant"
    text: str


@dataclass
class Device:
    id: str
    name: str
    commands: list[dict[str, Any]]  # flat list of SmartThings command objects
    room: str | None = None


@dataclass
class TurnContext:
    message: str                      # the user's latest message, verbatim
    history: list[Message]            # previous turns, already trimmed, oldest first
    devices: list[Device]
    bearer_token: str | None = None   # SmartThings token for this user (from Authorization header)
    extras: dict[str, Any] = field(default_factory=dict)  # e.g. {"location_context": {...}}
    capabilities: list[str] = field(default_factory=list)  # filled by the Agent: what the bot can do now
    # Optional progress sink (set by the streaming endpoint). Must be cheap and non-blocking.
    on_progress: Callable[[str, str], None] | None = field(default=None, repr=False)

    def progress(self, stage: str, text: str) -> None:
        """Report what the agent is doing now (shown live in the chat). Never raises."""
        if self.on_progress is not None:
            try:
                self.on_progress(stage, text)
            except Exception:  # a UI hint must never break a turn
                pass

    @property
    def role(self) -> str:
        """Who is asking: "admin", "technician" or "guest" (sent by the web app; unknown = the least privileged)."""
        r = str(self.extras.get("role") or "guest").lower()
        return r if r in {"admin", "technician", "guest"} else "guest"

    @property
    def is_staff(self) -> bool:
        return self.role in {"admin", "technician"}

    def history_text(self, last_n: int | None = None) -> str:
        turns = self.history if last_n is None else self.history[-last_n:]
        return "\n".join(f"{m.role}: {m.text}" for m in turns)

    def device_by_name(self, name: str) -> Device | None:
        return next((d for d in self.devices if d.name == name), None)
