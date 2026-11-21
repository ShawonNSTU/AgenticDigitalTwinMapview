"""Client for the digital twin's read-only floor + diagnostics API (host / technician sessions only).

    GET {twin_base}/floor            -> {time, scenario, rooms: [{id, name}], devices: [{id, name, type, room, health, finding?}]}
    GET {twin_base}/insight/{id}     -> {id, name, type, room, health, source, parts: [...], finding: {...} | null}

The bearer token is the same per-turn session the SmartThings calls use, so the twin decides what this turn may see.
Failures come back as a TwinResult, never raise.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import Settings

log = logging.getLogger("agent.twin")


@dataclass
class TwinResult:
    ok: bool
    data: Any = None
    error: str | None = None


class TwinClient:
    def __init__(self, settings: Settings):
        self.s = settings

    async def op(self, name: str, payload: dict[str, Any] | None, token: str | None) -> TwinResult:
        """POST {twin_base}/ops/{name}: an action beyond device commands (guest passes, routines, alerts, 3D simulation...)."""
        url = f"{self.s.twin_base}/ops/{name}"
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            async with httpx.AsyncClient(timeout=self.s.st_timeout_s * 4) as client:   # a routine runs many commands
                resp = await client.post(url, json=payload or {}, headers=headers)
        except httpx.HTTPError as exc:
            log.error("twin op %s failed: %s", name, exc)
            return TwinResult(False, error=str(exc) or type(exc).__name__)
        try:
            data: Any = resp.json()
        except ValueError:
            data = None
        if not 200 <= resp.status_code < 300 or not isinstance(data, dict):
            msg = (data or {}).get("error") if isinstance(data, dict) else None
            msg = msg.get("message") if isinstance(msg, dict) else msg
            return TwinResult(False, data, str(msg or f"HTTP {resp.status_code}"))
        return TwinResult(True, data)

    async def _get(self, path: str, token: str | None) -> TwinResult:
        url = f"{self.s.twin_base}/{path}"
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            async with httpx.AsyncClient(timeout=self.s.st_timeout_s) as client:
                resp = await client.get(url, headers=headers)
        except httpx.HTTPError as exc:
            log.error("twin GET %s failed: %s", path, exc)
            return TwinResult(False, error=str(exc) or type(exc).__name__)
        try:
            payload: Any = resp.json()
        except ValueError:
            payload = None
        if not 200 <= resp.status_code < 300 or not isinstance(payload, dict):
            return TwinResult(False, payload, f"HTTP {resp.status_code}")
        return TwinResult(True, payload)

    async def floor(self, token: str | None) -> TwinResult:
        return await self._get("floor", token)

    async def insight(self, device_id: str, token: str | None) -> TwinResult:
        return await self._get(f"insight/{device_id}", token)
