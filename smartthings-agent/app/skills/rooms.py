"""Skill: answer questions about rooms (which rooms exist, what is in a room, which room a device is in).

Data comes only from the rooms store (app/rooms/store.py). Activity (what was done in a room or on a
device) comes from the activity client, which is a placeholder until that API is disclosed.
"""
from __future__ import annotations

from app.core.context import TurnContext
from app.core.skill import ReplySkill, register
from app.devices.matching import exact_matches
from app.integrations.room_activity import RoomActivityClient, get_room_activity_client
from app.rooms.store import Room, room_of, rooms_for

MAX_ACTIVITY_LINES = 5

SYSTEM = """You are {bot}, an assistant in a SmartThings demo experience zone. Answer the user's question about the rooms here.

Rooms ({count} in total):
{rooms}
{unassigned}{activity}
Rules:
1. Use ONLY the rooms, devices and details listed above. If the answer is not there, say you don't have that information.
2. For "what is in a room" or "which devices are in a room", list only the devices of that room.
3. For "which room is a device in", name the room. If the device is not listed in any room, say so.
4. For "where is a room" or "which floor", use the floor and description if they are listed.
5. If recent activity is listed, you may mention it. If the user asks about activity and none is listed, say that activity information is not available yet.
6. Be brief: at most 3 sentences, plain text, no markdown. Never mention IDs.
"""


def _room_line(room: Room) -> str:
    parts = [f"- {room.name}"]
    if room.floor:
        parts.append(f"floor: {room.floor}")
    if room.description:
        parts.append(f"description: {room.description}")
    names = [d.name or d.id for d in room.devices]
    parts.append("devices: " + (", ".join(names) if names else "none listed yet"))
    return " | ".join(parts)


@register
class RoomsSkill(ReplySkill):
    name = "rooms"
    progress_text = "Checking rooms"
    description = "Rooms in the venue (e.g. Room 401, Gym Room, Dining Hall): which rooms exist, where a room is, which devices are in a room, which room a device is in, and what was done in a room or on a device."
    examples = ["which devices are in room 401?", "which room is the Desk Lamp in?", "what is in the gym room?", "what rooms are there?"]
    capability = "tell you which rooms exist and which devices are in each room"

    def __init__(self, llm, settings, activity: RoomActivityClient | None = None):
        super().__init__(llm, settings)
        self.activity = activity or get_room_activity_client(settings)

    def is_available(self, ctx: TurnContext) -> bool:
        return bool(rooms_for(ctx, self.settings))

    def build_prompt(self, ctx: TurnContext, request: str) -> tuple[str, str]:
        rooms = rooms_for(ctx, self.settings)

        unassigned = [d for d in ctx.devices if room_of(d, rooms) is None]
        unassigned_text = (
            "\nDevices not in any listed room: " + ", ".join(d.name for d in unassigned) + "\n"
            if unassigned else ""
        )

        activity_lines: list[str] = []
        for room in rooms:
            activity_lines += [f"{room.name}: {e}" for e in self.activity.room_events(room.id)]
        for d in exact_matches(request, ctx.devices)[:2]:  # device activity only for named devices
            activity_lines += [f"{d.name}: {e}" for e in self.activity.device_events(d.id)]
        activity_text = (
            "\nRecent activity:\n" + "\n".join(f"- {line}" for line in activity_lines[:MAX_ACTIVITY_LINES]) + "\n"
            if activity_lines else ""
        )

        system = SYSTEM.format(
            bot=self.settings.bot_name,
            count=len(rooms),
            rooms="\n".join(_room_line(r) for r in rooms),
            unassigned=unassigned_text,
            activity=activity_text,
        )
        return system, f"Question: {request}"
