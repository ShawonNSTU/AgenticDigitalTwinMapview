"""Room and device activity: what was done in a room or on a device (e.g. "the AC in room 401 was set to 24°").

PLACEHOLDER. The API for this has not been disclosed yet. Until it is:
  * `NullRoomActivityClient` returns nothing, so the rooms skill says activity info is not available.
  * Once the API is known, implement `HttpRoomActivityClient` (same two methods) and return it from
    `get_room_activity_client`. Nothing else needs to change.
"""
from __future__ import annotations

from typing import Protocol

from app.config import Settings


class RoomActivityClient(Protocol):
    def room_events(self, room_id: str) -> list[str]:
        """Short, user-readable lines about what happened in the room (most recent first)."""

    def device_events(self, device_id: str) -> list[str]:
        """Short, user-readable lines about actions performed on the device (most recent first)."""


class NullRoomActivityClient:
    """No activity API yet: nothing to report."""

    def room_events(self, room_id: str) -> list[str]:
        return []

    def device_events(self, device_id: str) -> list[str]:
        return []


def get_room_activity_client(settings: Settings) -> RoomActivityClient:
    # TODO: return the real client once the activity API is disclosed (settings may carry its URL/token).
    return NullRoomActivityClient()
