"""Room data: loading, lookup and attaching rooms to devices.

Source, in order of priority:
  1. `rooms_context` in the request `extras` (same shape as the file; replaces the file data)
  2. the file at ROOMS_DATA_PATH (default data/rooms.json, see data/rooms.example.json)

Shape:
  {"rooms": [{"id": "room-401", "name": "Room 401", "floor": "...", "description": "...",
              "devices": [{"id": "<device id>", "name": "<device name>"}]}]}

Room ids must be unique. Device matching uses the device id first, then the name (case-insensitive).
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.config import Settings
from app.core.context import Device, TurnContext

log = logging.getLogger("agent.rooms")


@dataclass(frozen=True)
class RoomDevice:
    id: str
    name: str


@dataclass(frozen=True)
class Room:
    id: str
    name: str
    floor: str = ""
    description: str = ""
    devices: tuple[RoomDevice, ...] = field(default_factory=tuple)


def parse_rooms(data: dict[str, Any]) -> list[Room]:
    rooms: list[Room] = []
    seen: set[str] = set()
    for r in data.get("rooms") or []:
        room_id = str(r.get("id") or "").strip()
        name = str(r.get("name") or "").strip()
        if not room_id or not name:
            raise ValueError(f"room needs an id and a name: {r!r}")
        if room_id in seen:
            raise ValueError(f"duplicate room id: {room_id}")
        seen.add(room_id)
        devices = tuple(
            RoomDevice(id=str(d.get("id") or "").strip(), name=str(d.get("name") or "").strip())
            for d in r.get("devices") or []
            if isinstance(d, dict) and (d.get("id") or d.get("name"))
        )
        rooms.append(Room(
            id=room_id,
            name=name,
            floor=str(r.get("floor") or "").strip(),
            description=str(r.get("description") or "").strip(),
            devices=devices,
        ))
    return rooms


_file_cache: dict[str, list[Room]] = {}


def load_rooms_file(path: Path) -> list[Room]:
    key = str(path)
    if key not in _file_cache:
        try:
            data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
            _file_cache[key] = parse_rooms(data)
        except (OSError, ValueError) as exc:  # JSONDecodeError is a ValueError
            log.error("cannot read rooms from %s: %s", path, exc)
            _file_cache[key] = []
    return _file_cache[key]


def rooms_for(ctx: TurnContext, settings: Settings) -> list[Room]:
    override = ctx.extras.get("rooms_context")
    if override:
        try:
            return parse_rooms(override)
        except ValueError as exc:
            log.error("invalid rooms_context: %s", exc)
    return load_rooms_file(settings.rooms_data_path)


def room_of(device: Device, rooms: list[Room]) -> Room | None:
    name = device.name.casefold()
    for room in rooms:
        for d in room.devices:
            if (d.id and d.id == device.id) or (d.name and d.name.casefold() == name):
                return room
    return None


def attach_rooms(ctx: TurnContext, rooms: list[Room]) -> None:
    """Fill `Device.room` from the room data. A room sent by the frontend on the device wins."""
    for device in ctx.devices:
        if device.room is None:
            room = room_of(device, rooms)
            if room:
                device.room = room.name
