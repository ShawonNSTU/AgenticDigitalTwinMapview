"""Where the model's reasoning goes during a turn.

The LLM layer has no TurnContext, so the agent sets a per-turn sink here (a ContextVar: concurrent turns never mix)
and the LLM pushes the model's thinking into it as it streams. Skills add their own short rationale with
`TurnContext.reason()`. The streaming API turns both into `reasoning` events for the UI."""
from __future__ import annotations

from contextvars import ContextVar
from typing import Callable

Sink = Callable[[str, str], None]          # (label of the LLM step, text delta)
reasoning_sink: ContextVar[Sink | None] = ContextVar("reasoning_sink", default=None)


def emit(label: str, text: str) -> None:
    sink = reasoning_sink.get()
    if sink is not None and text:
        try:
            sink(label, text)
        except Exception:  # a UI hint must never break a turn
            pass
