"""Recognising a floor the platform has a checked model of, and the cleaned drawing for the 3D floor."""
import asyncio
import base64

import cv2
import numpy as np
import pytest

from app import floorplan, known_plans, plan_cv
from plan_synth import draw, iou_rect


@pytest.mark.parametrize("style", ["thick", "hatched", "thin", "grey"])
def test_other_plans_are_not_taken_for_a_known_floor(style):
    img, _ = draw(style, 60)
    assert known_plans.image_match(img) is None
    assert known_plans.text_match(plan_cv.analyze(img)["_texts"]) is None


def test_room_names_recognise_the_reference_floor():
    texts = ["ZONE_D", "GYM Room", "Male Pray Room", "Female Pray Room / Store Room", "Ablution", "Utility Room", "AC Outdoor", "Store Room"]
    assert known_plans.text_match(texts) == "samsung-rnd-4f"
    # the same generic rooms without anything floor-specific are not enough
    assert known_plans.text_match(texts[1:]) is None


def _read(img):
    ok, png = cv2.imencode(".png", img)
    return asyncio.run(floorplan.analyze_plan("data:image/png;base64," + base64.b64encode(png.tobytes()).decode()))


def test_clean_drawing_is_cropped_to_the_building_with_rooms_moved_along(monkeypatch):
    monkeypatch.setattr(floorplan, "ANTHROPIC_API_KEY", "")
    img, truth = draw("thick", 60)
    out = _read(img)
    x0, y0, x1, y1 = out["crop"]
    assert x0 > 0.03 and y0 > 0.03 and x1 < 0.97 and y1 < 0.97      # the margins and the dimension line are gone
    clean = cv2.imdecode(np.frombuffer(base64.b64decode(out["image"].split(",", 1)[1]), np.uint8), cv2.IMREAD_GRAYSCALE)
    H, W = img.shape[:2]
    assert abs(clean.shape[1] / clean.shape[0] - (x1 - x0) * W / ((y1 - y0) * H)) < 0.02
    # rooms still match the truth once mapped back to the full sheet
    found = [[[x0 + p[0] * (x1 - x0), y0 + p[1] * (y1 - y0)] for p in r["points"]] for r in out["rooms"]]
    for name, rect in truth["rooms"]:
        assert max(iou_rect(f, rect) for f in found) > 0.8, name
    # the printed room names are erased from the drawing (the 3D map prints them itself)
    _, lines = plan_cv.ocr(clean)
    assert not [ln["text"] for ln in lines if plan_cv.ROOM_WORDS.search(ln["text"])]
    assert 0.5 * out["width_m"] < truth["width_m"] < 2 * out["width_m"]


def test_floor_name_read_from_the_title():
    assert floorplan._floor_name(["GROUND FLOOR PLAN"]) == "Ground floor"
    assert floorplan._floor_name(["Level 3"]) == "Level 3"
    assert floorplan._floor_name(["Kitchen"]) is None
