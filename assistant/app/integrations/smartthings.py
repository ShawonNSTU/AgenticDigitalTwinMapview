"""SmartThings REST client.

Commands: POST {base}/{deviceId}/commands with {"commands": [...]} (blocked by ST_DRY_RUN).
Reads:    GET  {base}/{deviceId}/status and /health. Reads never change a device, so they are
          always live, even in dry-run mode.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import Settings

log = logging.getLogger("agent.smartthings")


@dataclass
class CommandResult:
    ok: bool
    status_code: int | None
    response: Any = None
    error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"status_code": self.status_code, "response": self.response}
        if self.error:
            d["error"] = self.error
        return d


class SmartThingsClient:
    def __init__(self, settings: Settings):
        self.s = settings

    def _headers(self, token: str | None) -> dict[str, str]:
        token = token or self.s.st_default_token
        return {"Authorization": f"Bearer {token}"} if token else {}

    async def post_raw(self, device_id: str, body: dict[str, Any], token: str | None) -> CommandResult:
        if not device_id:
            return CommandResult(False, None, error="Device ID is required")
        if self.s.st_dry_run:
            log.info("[dry-run] %s <- %s", device_id, body)
            return CommandResult(True, 200, {"dry_run": True, "sent": body})

        url = f"{self.s.st_api_base_url}/{device_id}/commands"
        sep = "*" * 120
        print(f"\n{sep}\nST API REQUEST -> POST {url}\n{json.dumps(body, indent=2)}\n{sep}\n", flush=True)
        try:
            async with httpx.AsyncClient(timeout=self.s.st_timeout_s) as client:
                resp = await client.post(url, json=body, headers=self._headers(token))
        except httpx.HTTPError as exc:
            log.error("SmartThings request failed: %s", exc)
            return CommandResult(False, None, error=str(exc))

        try:
            payload: Any = resp.json()
        except ValueError:
            payload = resp.text
        ok = 200 <= resp.status_code < 300
        log.info("SmartThings %s -> %s %s", device_id, resp.status_code, payload)
        return CommandResult(ok, resp.status_code, payload, None if ok else f"HTTP {resp.status_code}")

    async def execute(self, device_id: str, commands: list[dict[str, Any]], token: str | None) -> CommandResult:
        return await self.post_raw(device_id, {"commands": commands}, token)

    async def get(self, device_id: str, path: str, token: str | None) -> CommandResult:
        """GET {base}/{device_id}/{path}. Failures come back as a CommandResult, never raise."""
        if not device_id:
            return CommandResult(False, None, error="Device ID is required")
        url = f"{self.s.st_api_base_url}/{device_id}/{path}"
        try:
            async with httpx.AsyncClient(timeout=self.s.st_timeout_s) as client:
                resp = await client.get(url, headers=self._headers(token))
        except httpx.HTTPError as exc:
            log.error("SmartThings GET %s failed: %s", path, exc)
            return CommandResult(False, None, error=str(exc) or type(exc).__name__)
        try:
            payload: Any = resp.json()
        except ValueError:
            payload = resp.text
        ok = 200 <= resp.status_code < 300
        log.debug("SmartThings GET %s/%s -> %s", device_id, path, resp.status_code)
        return CommandResult(ok, resp.status_code, payload, None if ok else f"HTTP {resp.status_code}")

    async def get_status(self, device_id: str, token: str | None) -> CommandResult:
        """Current attribute values: {"components": {component: {capability: {attribute: {"value", "unit"}}}}}."""
        return await self.get(device_id, "status", token)

    async def get_health(self, device_id: str, token: str | None) -> CommandResult:
        """{"state": "ONLINE" | "OFFLINE", ...}"""
        return await self.get(device_id, "health", token)
