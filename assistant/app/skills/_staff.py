"""Shared pieces of the staff skills (not a skill itself): one structured model call with closed choices, and the
twin operations they run. The model only picks from enums built from live twin data; code validates and acts."""
from __future__ import annotations

from typing import Any

from app.core.context import TurnContext
from app.integrations.twin import TwinClient, TwinResult


def enum_schema(props: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": required}


def one_of(values: list[str], allow_empty: bool = True) -> dict[str, Any]:
    vals = list(dict.fromkeys(values))
    return {"type": "string", "enum": ([""] if allow_empty else []) + vals}


async def need_op(twin: TwinClient, ctx: TurnContext, name: str, payload: dict[str, Any] | None = None) -> TwinResult:
    return await twin.op(name, payload or {}, ctx.bearer_token)


def pick_name(items: list[dict[str, Any]], key: str = "name") -> str:
    names = [str(i.get(key)) for i in items[:6]]
    return ", ".join(names) + (f" and {len(items) - 6} more" if len(items) > 6 else "")
