"""Image-processing floor plan reader on synthetic plans with known rooms and doors."""
import asyncio
import base64
import math
import shutil

import cv2
import pytest

from app.floorplan import reader as floorplan, plan_cv
from tests.floorplan.plan_synth import draw, iou_rect

STYLES = [("thick", 40), ("thick", 80), ("hatched", 80), ("thin", 40), ("thin", 80), ("grey", 40), ("grey", 80)]


@pytest.mark.parametrize("style,ppm", STYLES)
def test_rooms_doors_and_scale(style, ppm):
    img, truth = draw(style, ppm)
    r = plan_cv.analyze(img)
    assert len(truth["rooms"]) <= len(r["rooms"]) <= len(truth["rooms"]) + 1
    for name, rect in truth["rooms"]:
        assert max(iou_rect(x["points"], rect) for x in r["rooms"]) > 0.85, name
    assert len(truth["doors"]) <= len(r["doors"]) <= len(truth["doors"]) + 1
    # every real door found within 0.5 m, oriented along its wall
    W = truth["width_m"]
    for fx, fy, w, o in truth["doors"]:
        d = min(r["doors"], key=lambda d: math.hypot(d["fx"] - fx, d["fy"] - fy))
        assert math.hypot(d["fx"] - fx, d["fy"] - fy) * W < 0.5
        along = (math.cos(d["rot"]), -math.sin(d["rot"]))
        assert abs(along[0 if o == "h" else 1]) > 0.9
    assert abs(r["width_m"] - W) / W < 0.1


def test_neighbours_share_wall_lines():
    img, _ = draw("thick", 60)
    r = plan_cv.analyze(img)
    xs = sorted({p[0] for x in r["rooms"] for p in x["points"]})
    # all corners sit on a few shared wall lines (12 m plan: 0, 4.5, 6, 6.5, 9, 12 plus margins)
    assert len(xs) <= 7


@pytest.mark.skipif(not shutil.which("tesseract"), reason="tesseract not installed")
def test_names_read_from_the_plan():
    img, truth = draw("thick", 80)
    names = {x["name"] for x in plan_cv.analyze(img)["rooms"]}
    assert {"Kitchen", "Dining", "Bedroom", "Master Bedroom", "Living Room"} <= names


def test_photo_of_sheet_asks_to_straighten():
    img, _ = draw("thick", 60, skew=True)
    r = plan_cv.analyze(img)
    assert r["photo_corners"] and len(r["photo_corners"]) == 4


def test_blank_image_finds_nothing(monkeypatch):
    monkeypatch.setattr(floorplan, "ANTHROPIC_API_KEY", "")
    ok, png = cv2.imencode(".png", 255 * __import__("numpy").ones((300, 400, 3), "uint8"))
    with pytest.raises(floorplan.ParseError, match="No rooms"):
        asyncio.run(floorplan.analyze_plan("data:image/png;base64," + base64.b64encode(png.tobytes()).decode()))


def test_endpoint_flow_without_key(monkeypatch):
    monkeypatch.setattr(floorplan, "ANTHROPIC_API_KEY", "")
    img, truth = draw("grey", 60)
    ok, png = cv2.imencode(".png", img)
    out = asyncio.run(floorplan.analyze_plan("data:image/png;base64," + base64.b64encode(png.tobytes()).decode()))
    assert out["method"] == "image processing"
    assert len(out["rooms"]) == 8 and len(out["doors"]) >= 8
    assert not any(k.startswith("_") for k in out)


def test_merge_names_from_vision_and_adds_missed_rooms():
    cvr = {"rooms": [{"name": "Room 1", "points": [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]], "id": 1},
                     {"name": "Kitchen", "points": [[0.5, 0], [1, 0], [1, 0.5], [0.5, 0.5]], "id": 2}],
           "doors": [], "photo_corners": None, "width_m": 10, "scale_note": "x"}
    ai = {"rooms": [{"name": "Lounge", "points": [[0.02, 0.02], [0.48, 0.02], [0.48, 0.48], [0.02, 0.48]]},
                    {"name": "Cooking", "points": [[0.5, 0], [1, 0], [1, 0.5], [0.5, 0.5]]},
                    {"name": "Terrace", "points": [[0, 0.6], [1, 0.6], [1, 1], [0, 1]]}],
          "furniture": [{"kind": "sofa", "fx": 0.2, "fy": 0.2, "fw": 0.1, "fd": 0.05, "rot": 0}], "outdoor": None, "photo_corners": None}
    out = floorplan.merge(cvr, ai)
    names = [r["name"] for r in out["rooms"]]
    assert names == ["Lounge", "Kitchen", "Terrace"]          # OCR name kept, unread name from vision, missed room added
    assert out["furniture"][0]["kind"] == "sofa"
    assert out["rooms"][0].get("id") is None


def test_merge_falls_back_to_vision_outlines():
    out = floorplan.merge({"rooms": [], "doors": [], "photo_corners": None}, {"rooms": [{"name": "A", "points": [[0, 0], [1, 0], [1, 1]]}], "furniture": [], "photo_corners": None})
    assert out["method"] == "Claude vision" and out["rooms"][0]["name"] == "A"


def test_straightened_photo_with_dark_margins():
    """After the editor straightens a photo, the table around the sheet is left in the corners. It must not read as walls."""
    import numpy as np
    img, truth = draw("thick", 60, skew=True)
    H, W = img.shape[:2]
    c = np.float32([[p[0] * W, p[1] * H] for p in plan_cv.analyze(img)["photo_corners"]])
    m = 0.1
    dst = np.float32([[m * W, m * H], [(1 - m) * W, m * H], [(1 - m) * W, (1 - m) * H], [m * W, (1 - m) * H]])
    flat = cv2.warpPerspective(img, cv2.getPerspectiveTransform(c, dst), (W, H), borderValue=(60, 70, 80))
    r = plan_cv.analyze(flat)
    assert r["photo_corners"] is None
    assert len(truth["rooms"]) <= len(r["rooms"]) <= len(truth["rooms"]) + 1


@pytest.mark.parametrize("style,ppm", [("thick", 60), ("thin", 80), ("grey", 60)])
def test_doors_open_to_the_side_their_swing_is_drawn(style, ppm):
    # the synthetic plan draws every swing south of a horizontal wall and east of a vertical one
    img, truth = draw(style, ppm)
    r = plan_cv.analyze(img)
    W = truth["width_m"]
    checked = 0
    for fx, fy, w, o in truth["doors"]:
        if fx * W > W - 1.6:   # the front door's swing is drawn outside the building: no wall beyond to read against
            continue
        d = min(r["doors"], key=lambda d: math.hypot(d["fx"] - fx, d["fy"] - fy))
        leaf = (math.sin(d["rot"]), math.cos(d["rot"]))   # the renderer opens the leaf this way
        assert (leaf[1] if o == "h" else leaf[0]) > 0.9, (fx, fy, o, d["rot"])
        checked += 1
    assert checked >= 6
