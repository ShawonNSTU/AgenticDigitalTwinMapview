import json
from pathlib import Path
import pytest

DATA = Path(__file__).resolve().parents[2] / "web" / "lib" / "sim" / "data"
LABELS = {k: v["label"] for k, v in json.loads((DATA / "device_types.json").read_text()).items()}


@pytest.fixture
def floor():
    """Floor snapshot shaped like GET /api/floor, with a filter-clog fault on AC-05."""
    rooms = json.loads((DATA / "building.json").read_text())["rooms"]
    devices = json.loads((DATA / "devices.json").read_text())
    for d in devices:
        d["label"] = LABELS[d["type"]]
        d["health"] = {"AC-05": "fault", "AC-04": "watch"}.get(d["id"], "ok")
    return {"time": 14.0, "rooms": rooms, "devices": devices}


class FakePlatform:
    def __init__(self, floor):
        self._floor = floor
        self.sent = []

    async def floor(self):
        return self._floor

    async def sim(self):
        return {"t": 14.0, "scenario": "filter"}

    async def device(self, device_id):
        d = next(x for x in self._floor["devices"] if x["id"] == device_id)
        f = {"lvl": "fault", "title": "Airflow blocked", "conf": "Inferred", "ev": ["Airflow 40 %"], "steps": [{"t": "Fan only", "p": "coil"}]} if device_id == "AC-05" else None
        return {**d, "parts": [], "finding": f}

    async def commands(self, device_id):
        return {"commands": []}

    async def command(self, device_id, command, args, confirmed):
        self.sent.append((device_id, command, args, confirmed))
        if command == "unlock" and not confirmed:
            return {"ok": False, "needsConfirmation": True, "error": "needs confirmation"}
        return {"ok": True, "device": await self.device(device_id)}

    async def set_sim(self, **kw):
        return kw


@pytest.fixture
def platform(floor):
    return FakePlatform(floor)
