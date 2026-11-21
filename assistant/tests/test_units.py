"""Unit tests: catalog compaction, value validation, matching, JSON helpers, normalization."""
import pytest

from app.core.jsonutil import extract_json, validate
from app.devices.catalog import ValueProblem, build_actions, capability_summary
from app.devices.matching import exact_matches, single_exact_match
from app.normalize import build_history, flatten_commands


def dev(devices, name):
    return next(d for d in devices if d.name == name)


def actions_by_id(device):
    return {a.id: a for a in build_actions(device)}


def test_light_commands_are_compacted(devices):
    acts = actions_by_id(dev(devices, "Light 1"))
    # setColor takes an object (hue + saturation) and is not offered in chat, so it is dropped
    assert set(acts) == {
        "switch.on", "switch.off", "switchLevel.setLevel", "colorTemperature.setColorTemperature",
    }
    level = acts["switchLevel.setLevel"]
    assert level.slot and level.slot.kind == "integer" and not level.options
    temp = acts["colorTemperature.setColorTemperature"]
    assert temp.slot and (temp.slot.minimum, temp.slot.maximum) == (2200, 6500)


def test_values_are_validated_and_commands_rebuilt_exactly(devices):
    acts = actions_by_id(dev(devices, "Light 1"))
    temp = acts["colorTemperature.setColorTemperature"]
    args, shown = temp.resolve("4000K")
    assert args == [4000] and shown == "4000"
    assert temp.build(args) == {
        "component": "main", "capability": "colorTemperature",
        "command": "setColorTemperature", "arguments": [4000],
    }
    with pytest.raises(ValueProblem):
        temp.resolve("")
    with pytest.raises(ValueProblem):
        temp.resolve("9000")


def test_range_argument_becomes_bounded_slot(devices):
    level = actions_by_id(dev(devices, "Desk Lamp"))["switchLevel.setLevel"]
    assert level.slot and (level.slot.minimum, level.slot.maximum) == (1, 100)
    assert level.resolve("40%")[0] == [40]
    with pytest.raises(ValueProblem):
        level.resolve("150")
    with pytest.raises(ValueProblem):
        level.resolve("0")


def test_shade_position_is_bounded_0_to_100(devices):
    pos = actions_by_id(dev(devices, "Aqara Roller Shade Controller"))["windowShadeLevel.setShadeLevel"]
    assert (pos.slot.minimum, pos.slot.maximum) == (0, 100)
    assert pos.resolve("50")[0] == [50]
    with pytest.raises(ValueProblem):
        pos.resolve("101")


def test_no_arg_actions_need_no_value(devices):
    opened = actions_by_id(dev(devices, "Aqara Roller Shade Controller"))["windowShade.open"]
    assert not opened.needs_value and opened.resolve(None) == ([], "")
    on = actions_by_id(dev(devices, "Blinds Switch"))["switch.on"]
    assert not on.needs_value and on.resolve(None) == ([], "")


def test_describe_lines_are_compact(devices):
    lines = [a.describe() for a in build_actions(dev(devices, "Light 1"))]
    assert len(lines) == 4 and all(len(line) < 200 for line in lines)
    assert capability_summary(dev(devices, "Aqara Roller Shade Controller")).startswith("blinds / shade, ")


def test_exact_device_matching(devices):
    assert single_exact_match("turn on the desk lamp please", devices).name == "Desk Lamp"
    assert single_exact_match("Turn on TV Lamp", devices).name == "TV Lamp"
    assert single_exact_match("light 3 to 30%", devices).name == "Light 3"
    assert single_exact_match("turn on the lamp", devices) is None
    assert {d.name for d in exact_matches("light 1 and blinds switch", devices)} == {"Light 1", "Blinds Switch"}


def test_extract_json_handles_noise():
    assert extract_json('Sure! ```json\n{"a": 1}\n``` done') == {"a": 1}
    assert extract_json('thinking... {"a": {"b": "}"}} trailing') == {"a": {"b": "}"}}
    with pytest.raises(ValueError):
        extract_json("no json here")


def test_validate():
    schema = {"type": "object", "properties": {"x": {"type": "string", "enum": ["a"]}}, "required": ["x"]}
    assert validate({"x": "a"}, schema) == []
    assert validate({"x": "b"}, schema) and validate({}, schema)


def test_flatten_both_command_formats():
    cmd = {"component": "main", "capability": "switch", "command": "on", "arguments": []}
    assert flatten_commands([{"commands": [cmd]}, {"commands": cmd}, cmd]) == [cmd, cmd, cmd]


def test_history_is_deduplicated_and_trimmed(settings):
    raw = [{"text": f"m{i}", "role": "user" if i % 2 else "assistant"} for i in range(10)]
    raw.append({"text": "now", "role": "user"})
    hist = build_history(raw, "now", settings)
    assert len(hist) == settings.history_max_messages and hist[-1].text == "m9"
