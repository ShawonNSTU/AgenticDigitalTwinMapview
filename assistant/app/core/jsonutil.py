"""JSON helpers: robust extraction from model text + a tiny JSON-schema validator.

Only the schema features used by this project are supported:
type (object/string/integer/number/boolean/array/null, or a list of types), enum,
properties, required, items, additionalProperties is ignored.
"""
from __future__ import annotations

import json
import re
from typing import Any

_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


def extract_json(text: str) -> dict[str, Any]:
    """Return the first JSON object found in `text`. Raises ValueError if none."""
    if not text or not text.strip():
        raise ValueError("empty response")
    text = text.strip()
    candidates = [m.group(1) for m in _FENCE.finditer(text)] + [text]
    for chunk in candidates:
        chunk = chunk.strip()
        try:
            obj = json.loads(chunk)
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass
        obj = _first_balanced_object(chunk)
        if obj is not None:
            return obj
    raise ValueError("no JSON object found in response")


def _first_balanced_object(text: str) -> dict[str, Any] | None:
    start = text.find("{")
    while start != -1:
        depth, in_str, esc = 0, False, False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            elif ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(text[start : i + 1])
                        if isinstance(obj, dict):
                            return obj
                    except json.JSONDecodeError:
                        pass
                    break
        start = text.find("{", start + 1)
    return None


_TYPE_CHECKS = {
    "object": lambda v: isinstance(v, dict),
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "array": lambda v: isinstance(v, list),
    "null": lambda v: v is None,
}


def validate(obj: Any, schema: dict[str, Any], path: str = "$") -> list[str]:
    """Return a list of human-readable errors (empty list = valid)."""
    errors: list[str] = []
    types = schema.get("type")
    if types:
        types = [types] if isinstance(types, str) else types
        if not any(_TYPE_CHECKS[t](obj) for t in types):
            return [f"{path} must be of type {' or '.join(types)}"]
    if "enum" in schema and obj not in schema["enum"]:
        allowed = ", ".join(json.dumps(e) for e in schema["enum"])
        errors.append(f"{path} must be one of: {allowed}")
    if isinstance(obj, dict):
        for key in schema.get("required", []):
            if key not in obj:
                errors.append(f"{path}.{key} is required")
        for key, sub in schema.get("properties", {}).items():
            if key in obj:
                errors.extend(validate(obj[key], sub, f"{path}.{key}"))
    if isinstance(obj, list) and "items" in schema:
        for i, item in enumerate(obj):
            errors.extend(validate(item, schema["items"], f"{path}[{i}]"))
    return errors
