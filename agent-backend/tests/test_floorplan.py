import asyncio
import pytest
from app import floorplan
from app.floorplan import ParseError, parse_json


def test_parse_json_cleans_and_orders():
    text = 'Here you go: {"rooms": [{"name": "Kitchen", "x0": 0.5, "y0": 0.4, "x1": 0.1, "y1": 0.1}, {"name": "tiny", "x0": 0, "y0": 0, "x1": 0.01, "y1": 0.5}, {"bad": 1}], "outdoor": {"x": 0.5, "y": 1.1}}'
    out = parse_json(text)
    assert out["rooms"] == [{"name": "Kitchen", "x0": 0.1, "y0": 0.1, "x1": 0.5, "y1": 0.4}]
    assert out["outdoor"] == {"x": 0.5, "y": 1.1}


def test_parse_json_rejects_prose():
    with pytest.raises(ParseError):
        parse_json("I can't see a plan")


def test_detect_without_key_explains(monkeypatch):
    monkeypatch.setattr(floorplan, "ANTHROPIC_API_KEY", "")
    with pytest.raises(ParseError, match="Draw the rooms by hand"):
        asyncio.run(floorplan.detect_rooms("data:image/png;base64,AAAA"))
