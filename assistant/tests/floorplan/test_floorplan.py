import asyncio
import pytest
from app.floorplan import reader as floorplan
from app.floorplan.reader import ParseError, parse_json


def test_parse_json_polygons_and_rectangles():
    text = ('Here you go: {"rooms": ['
            '{"name": "Living", "points": [[0.1, 0.1], [0.6, 0.1], [0.6, 0.3], [0.35, 0.3], [0.35, 0.6], [0.1, 0.6], [0.1, 0.1]]},'
            '{"name": "Kitchen", "x0": 0.9, "y0": 0.4, "x1": 0.6, "y1": 0.1},'
            '{"name": "tiny", "points": [[0, 0], [0.01, 0], [0.01, 0.01]]}, {"bad": 1}, "junk"],'
            '"outdoor": {"x": 0.5, "y": 1.1}}')
    out = parse_json(text)
    assert [r["name"] for r in out["rooms"]] == ["Living", "Kitchen"]
    assert len(out["rooms"][0]["points"]) == 6  # L-shape kept, closing corner dropped
    assert out["rooms"][1]["points"] == [[0.6, 0.1], [0.9, 0.1], [0.9, 0.4], [0.6, 0.4]]
    assert out["outdoor"] == {"x": 0.5, "y": 1.1}


def test_parse_json_rejects_prose():
    with pytest.raises(ParseError):
        parse_json("I can't see a plan")


def test_bad_image_is_a_parse_error(monkeypatch):
    monkeypatch.setattr(floorplan, "ANTHROPIC_API_KEY", "")
    with pytest.raises(ParseError):
        asyncio.run(floorplan.analyze_plan("data:image/png;base64,AAAA"))
    with pytest.raises(ParseError):
        asyncio.run(floorplan.analyze_plan("not a data url"))


def test_photo_corners_passed_through():
    out = parse_json('{"rooms": [], "outdoor": null, "photo_corners": [[0.1, 0.05], [0.95, 0.07], [0.97, 0.9], [0.12, 0.85]]}')
    assert out["photo_corners"][2] == [0.97, 0.9]
    assert parse_json('{"rooms": [], "photo_corners": [[0, 0]]}')["photo_corners"] is None


def test_furniture_cleaned_and_rotation_in_radians():
    out = parse_json('{"rooms": [], "photo_corners": [[0,0],[1,0],[1,1],[0,1]], "furniture": ['
                     '{"kind": "chair", "x": 0.3, "y": 0.4, "w": 0.01, "d": 0.01, "rot": 180},'
                     '{"kind": "spaceship", "x": 0.3, "y": 0.4, "w": 0.01, "d": 0.01},'
                     '{"kind": "table", "x": 0.3, "y": 0.4, "w": 0.9, "d": 0.01}]}')
    assert len(out["furniture"]) == 1 and out["furniture"][0]["kind"] == "chair"
    assert abs(out["furniture"][0]["rot"] - 3.1416) < 1e-3
