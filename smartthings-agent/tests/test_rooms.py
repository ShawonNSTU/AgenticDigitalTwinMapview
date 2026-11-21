"""Rooms: data loading, device-to-room lookup, the rooms skill prompt and the activity placeholder."""
from dataclasses import replace

import pytest

from app.core.context import Device
from app.integrations.room_activity import NullRoomActivityClient, get_room_activity_client
from app.normalize import build_context
from app.rooms.store import attach_rooms, parse_rooms, rooms_for
from app.skills.rooms import RoomsSkill
from tests.conftest import ROOT, FakeLLM, sample_request


def route(skill, request):
    return {"skill": skill, "request": request}


def test_example_file_has_venue_rooms_and_all_demo_devices_in_smartthings_zone():
    import json
    data = json.loads((ROOT / "data" / "rooms.example.json").read_text())
    rooms = parse_rooms(data)
    assert len(rooms) == 18
    assert rooms[0].id == "cafeteria" and rooms[0].name == "Cafeteria"
    zone = next(r for r in rooms if r.id == "smartthings")
    assert zone.name == "SmartThings experience zone" and len(zone.devices) == 13
    assert all(not r.devices for r in rooms if r.id != "smartthings")


def test_duplicate_or_missing_room_ids_are_rejected():
    with pytest.raises(ValueError):
        parse_rooms({"rooms": [{"id": "a", "name": "A"}, {"id": "a", "name": "B"}]})
    with pytest.raises(ValueError):
        parse_rooms({"rooms": [{"name": "No id"}]})


def test_devices_get_room_from_file_by_id_or_name(settings):
    ctx = build_context(sample_request("hi"), None, settings)
    assert {d.room for d in ctx.devices} == {"SmartThings experience zone"}


def test_frontend_room_wins_over_file(settings):
    req = sample_request("hi")
    req.devices = None
    ctx = build_context(req, None, settings)
    ctx.devices[0].room = "Gym Room"
    attach_rooms(ctx, rooms_for(ctx, settings))
    assert ctx.devices[0].room == "Gym Room"


def test_rooms_context_in_request_overrides_file(settings):
    override = {"rooms": [{"id": "x", "name": "Lab", "devices": [{"name": "Desk Lamp"}]}]}
    ctx = build_context(sample_request("hi", extras={"rooms_context": override}), None, settings)
    lamp = next(d for d in ctx.devices if d.name == "Desk Lamp")
    assert lamp.room == "Lab"
    assert next(d for d in ctx.devices if d.name == "Light 2").room is None


def test_missing_file_means_no_rooms_and_skill_hidden(settings):
    s = replace(settings, rooms_data_path=ROOT / "data" / "does-not-exist.json")
    ctx = build_context(sample_request("hi"), None, s)
    assert all(d.room is None for d in ctx.devices)
    assert not RoomsSkill(FakeLLM(), s).is_available(ctx)


def test_prompt_lists_rooms_devices_and_unassigned(settings):
    ctx = build_context(sample_request("which devices are in room 401?"), None, settings)
    system, user = RoomsSkill(FakeLLM(), settings).build_prompt(ctx, "which devices are in room 401?")
    assert "SmartThings experience zone | devices: Aqara Roller Shade Controller, Blinds Switch" in system
    assert "Gym | devices: none listed yet" in system
    assert "Devices not in any listed room" not in system  # every demo device is in the zone
    assert "Question: which devices are in room 401?" == user


def test_unassigned_devices_are_listed(settings):
    ctx = build_context(sample_request("hi"), None, settings)
    ctx.devices.append(Device(id="new", name="Lamp 2", commands=[]))
    system, _ = RoomsSkill(FakeLLM(), settings).build_prompt(ctx, "where is lamp 2?")
    assert "Devices not in any listed room: Lamp 2" in system


def test_activity_placeholder_is_empty_and_prompt_says_unavailable(settings):
    assert get_room_activity_client(settings).room_events("room-401") == []
    assert NullRoomActivityClient().device_events("any") == []
    ctx = build_context(sample_request("what happened in room 401?"), None, settings)
    system, _ = RoomsSkill(FakeLLM(), settings).build_prompt(ctx, "what happened in room 401?")
    assert "Recent activity" not in system
    assert "activity information is not available yet" in system


class FakeActivity:
    def room_events(self, room_id):
        return ["AC set to 24°"] if room_id == "smartthings" else []

    def device_events(self, device_id):
        return ["turned on"]


async def test_skill_run_uses_activity_when_available(settings):
    llm = FakeLLM({"rooms": [{"reply": "SmartThings zone: AC set to 24°."}]})
    skill = RoomsSkill(llm, settings, activity=FakeActivity())
    ctx = build_context(sample_request("what happened in the SmartThings zone?"), None, settings)
    res = await skill.run(ctx, "what happened in the SmartThings zone?")
    assert res.message == "SmartThings zone: AC set to 24°."
    assert "SmartThings experience zone: AC set to 24°" in llm.calls[0]["system"]


async def test_router_can_pick_rooms_skill(make_agent, settings):
    agent, llm = make_agent({
        "router": [route("rooms", "which devices are in room 401?")],
        "rooms": [{"reply": "Room 401 has 13 devices, including the Desk Lamp."}],
    })
    ctx = build_context(sample_request("which devices are in room 401?"), None, settings)
    res = await agent.handle(ctx)
    assert res.status == "clarify" and res.data["skill"] == "rooms"
    assert "rooms" in llm.calls[0]["schema"]["properties"]["skill"]["enum"]
