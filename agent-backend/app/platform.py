"""Client for the simulated device platform served by the Next.js app (web/app/api)."""
from typing import Any
import httpx
from .config import PLATFORM_URL


class PlatformError(RuntimeError):
    pass


class Platform:
    def __init__(self, base: str = PLATFORM_URL, client: httpx.AsyncClient | None = None):
        self.base = base
        self.client = client or httpx.AsyncClient(timeout=10)

    async def _get(self, path: str, **params: Any) -> Any:
        try:
            r = await self.client.get(f"{self.base}{path}", params={k: v for k, v in params.items() if v is not None})
        except httpx.HTTPError as e:
            raise PlatformError(f"Device platform not reachable at {self.base}: {e}") from e
        if r.status_code >= 400:
            try:
                msg = r.json().get("error", r.text)
            except ValueError:
                msg = r.text
            raise PlatformError(f"{path}: {msg}")
        return r.json()

    async def floor(self) -> dict:
        return await self._get("/api/floor")

    async def device(self, device_id: str) -> dict:
        return await self._get(f"/api/devices/{device_id}")

    async def history(self, device_id: str, part: str) -> dict:
        return await self._get(f"/api/devices/{device_id}/history", part=part)

    async def commands(self, device_id: str) -> dict:
        return await self._get(f"/api/devices/{device_id}/commands")

    async def sim(self) -> dict:
        return await self._get("/api/sim")

    async def set_sim(self, **body: Any) -> dict:
        try:
            r = await self.client.post(f"{self.base}/api/sim", json={k: v for k, v in body.items() if v is not None})
        except httpx.HTTPError as e:
            raise PlatformError(f"Device platform not reachable at {self.base}: {e}") from e
        return r.json()

    async def command(self, device_id: str, command: str, args: dict, confirmed: bool) -> dict:
        try:
            r = await self.client.post(
                f"{self.base}/api/devices/{device_id}/commands",
                json={"command": command, "args": args, "confirmed": confirmed, "by": "agent"},
            )
        except httpx.HTTPError as e:
            raise PlatformError(f"Device platform not reachable at {self.base}: {e}") from e
        return r.json()
