"""Deterministic device-name matching (no LLM).

Used as a fast path (an exact device name in the request skips the LLM call) and to shortlist
candidates when a venue has many devices, so the model's prompt stays small.
"""
from __future__ import annotations

import re

from app.core.context import Device
from app.devices.catalog import capability_summary


def _words(text: str) -> str:
    return " " + " ".join(re.findall(r"[a-z0-9]+", text.lower())) + " "


def exact_matches(request: str, devices: list[Device]) -> list[Device]:
    """Devices whose full name appears in the request (word boundaries, case/punctuation-insensitive)."""
    req = _words(request)
    hits = [d for d in devices if _words(d.name).strip() and _words(d.name) in req]
    # "TV" vs "Lounge TV": drop names fully contained in a longer matched name
    return [d for d in hits if not any(o is not d and _words(d.name) in _words(o.name) for o in hits)]


def single_exact_match(request: str, devices: list[Device]) -> Device | None:
    hits = exact_matches(request, devices)
    return hits[0] if len(hits) == 1 else None


def shortlist(request: str, devices: list[Device], limit: int) -> list[Device]:
    """Keep the `limit` devices that share the most words with the request (original order on ties)."""
    if len(devices) <= limit:
        return devices
    req = set(_words(request).split())

    def score(d: Device) -> int:
        words = set(_words(f"{d.name} {d.room or ''} {capability_summary(d)}").split())
        return len(req & words)

    ranked = sorted(enumerate(devices), key=lambda p: (-score(p[1]), p[0]))
    return [d for _, d in ranked[:limit]]
