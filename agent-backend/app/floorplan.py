"""Floor plan analysis for any uploaded image.

Two readers work together:
  * plan_cv (OpenCV, always available): walls, room outlines on wall centre lines, doors, scale, printed names.
  * Claude vision (when ANTHROPIC_API_KEY is set): room names, interior items, the outdoor unit spot, and rooms the
    image processing missed.
The result is rooms as polygons in 0..1 image coordinates plus doors and furniture. The user reviews and edits
everything in the web editor before the 3D map is built, so mistakes here are cheap.
"""
import asyncio
import base64
import json
import math
import re

import cv2
import numpy as np

from . import known_plans, plan_cv

from .config import ANTHROPIC_API_KEY, AGENT_MODEL

PROMPT = """This is an architectural floor plan. Trace every room as a polygon following the inside face of its walls.
Rooms are often not rectangles: L-shapes, angled walls, bay windows and notches must be traced corner by corner.
Use coordinates as fractions of the image: x from 0 (left) to 1 (right), y from 0 (top) to 1 (bottom).
List corners in order around the room (clockwise), without repeating the first corner. Use as many corners as the shape needs; a plain rectangle has 4.
Neighbouring rooms should share their wall lines: give the same coordinates for the same wall.
Use the room names printed on the plan when there are any; otherwise a short plain name such as "Bedroom 2". Include balconies and decks.
Leave out furniture, door swings and dimension lines.
If the plan shows where the outdoor AC unit or the back yard is, give a point for it, else null.
If the image is a photo of a printed plan taken at an angle (the drawing's straight walls or frame are visibly skewed),
also give "photo_corners": the four corners of the drawing frame (or, if not visible, of the building outline) in the order
top-left, top-right, bottom-right, bottom-left. Otherwise give null.
Also list the interior items drawn on the plan as "furniture": structural columns, chairs, tables, desks, workstation pods,
sofas, beds, cabinets, shelves, racks, counters, sinks, toilets, stairs, screens, railings and gym equipment. For each give
kind (one of: column, chair, task_chair, table, round_table, desk, workstation, sofa, armchair, bed, cabinet, shelf, rack,
counter, sink, toilet, stair, screen, railing, treadmill, bike, weight_rack, plant), its centre x, y (fractions of image
width and height), its size w (across) and d (front to back) as fractions of the image WIDTH, and rot: the direction it faces
in degrees, 0 = towards the bottom of the image, 90 = towards the right, 180 = up, -90 = left (a chair faces its table, a desk
faces its user's back, a stair faces upwards along its run). List every seat individually; if there are more than 600 items,
list the largest 600.
Reply with JSON only:
{"rooms": [{"name": "Kitchen", "points": [[0.1, 0.2], [0.4, 0.2], [0.4, 0.5], [0.1, 0.5]]}], "outdoor": {"x": 0.5, "y": 1.05}, "photo_corners": null,
 "furniture": [{"kind": "table", "x": 0.25, "y": 0.35, "w": 0.04, "d": 0.015, "rot": 0}]}"""


class ParseError(RuntimeError):
    pass


def _area(pts: list) -> float:
    return abs(sum(pts[k][0] * pts[k - 1][1] - pts[k - 1][0] * pts[k][1] for k in range(len(pts)))) / 2


def _points(r: dict) -> list | None:
    """Accept {points: [[x, y], ...]} or a rectangle {x0, y0, x1, y1}."""
    try:
        if "points" in r:
            pts = [(float(p[0]), float(p[1])) for p in r["points"]]
        else:
            x0, x1 = sorted((float(r["x0"]), float(r["x1"])))
            y0, y1 = sorted((float(r["y0"]), float(r["y1"])))
            pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    except (KeyError, TypeError, ValueError, IndexError):
        return None
    pts = [(round(max(-0.2, min(1.2, x)), 4), round(max(-0.2, min(1.2, y)), 4)) for x, y in pts]
    # drop repeated corners (including a closing corner equal to the first)
    out = []
    for p in pts:
        if not out or abs(p[0] - out[-1][0]) + abs(p[1] - out[-1][1]) > 1e-4:
            out.append(p)
    if len(out) > 1 and abs(out[0][0] - out[-1][0]) + abs(out[0][1] - out[-1][1]) <= 1e-4:
        out.pop()
    if len(out) < 3 or _area(out) < 0.0004:
        return None
    return [list(p) for p in out]


def _clean(data: dict) -> dict:
    rooms = []
    for r in data.get("rooms", []):
        if not isinstance(r, dict):
            continue
        pts = _points(r)
        if pts:
            rooms.append({"name": str(r.get("name") or "Room")[:40], "points": pts[:200]})
    out = data.get("outdoor")
    outdoor = {"x": float(out["x"]), "y": float(out["y"])} if isinstance(out, dict) and "x" in out and "y" in out else None
    corners = None
    pc = data.get("photo_corners")
    if isinstance(pc, list) and len(pc) == 4:
        try:
            corners = [[round(float(p[0]), 4), round(float(p[1]), 4)] for p in pc]
        except (TypeError, ValueError, IndexError):
            corners = None
    kinds = {"column", "chair", "task_chair", "table", "round_table", "desk", "workstation", "sofa", "armchair", "bed", "cabinet", "shelf",
             "rack", "counter", "sink", "toilet", "stair", "screen", "railing", "treadmill", "bike", "weight_rack", "plant", "door"}
    furniture = []
    for f in data.get("furniture") or []:
        try:
            k = str(f["kind"])
            x, y, w, d = (float(f[a]) for a in ("x", "y", "w", "d"))
            rot = math.radians(float(f.get("rot", 0) or 0))
        except (KeyError, TypeError, ValueError):
            continue
        if k in kinds and -0.2 <= x <= 1.2 and -0.2 <= y <= 1.2 and 0 < w < 0.5 and 0 < d < 0.5:
            furniture.append({"kind": k, "fx": round(x, 5), "fy": round(y, 5), "fw": round(w, 5), "fd": round(d, 5), "rot": round(rot, 4)})
    return {"rooms": rooms[:60], "outdoor": outdoor, "photo_corners": corners, "furniture": furniture[:3000]}


def parse_json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ParseError("The model did not return JSON")
    try:
        return _clean(json.loads(m.group(0)))
    except json.JSONDecodeError as e:
        raise ParseError(f"Bad JSON from the model: {e}") from e


def _decode(data_url: str) -> tuple[str, bytes]:
    m = re.match(r"^data:(image/(?:png|jpeg|webp|gif));base64,(.+)$", data_url, re.S)
    if not m:
        raise ParseError("image must be a base64 data URL (PNG, JPEG, WebP or GIF)")
    try:
        return m.group(1), base64.b64decode(m.group(2))
    except ValueError as e:
        raise ParseError("image data is not valid base64") from e


async def vision(media_type: str, data: bytes) -> dict:
    from anthropic import AsyncAnthropic

    client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    resp = await client.messages.create(
        model=AGENT_MODEL,
        max_tokens=16000,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": base64.b64encode(data).decode()}},
            {"type": "text", "text": PROMPT},
        ]}],
    )
    return parse_json("".join(b.text for b in resp.content if b.type == "text"))


def _raster(points: list, S: int = 400) -> np.ndarray:
    m = np.zeros((S, S), np.uint8)
    cv2.fillPoly(m, [np.array([[x * S, y * S] for x, y in points], np.int32)], 1)
    return m


def merge(cvr: dict, ai: dict | None) -> dict:
    """Combine the image-processing result with the vision model's. Geometry from plan_cv, names and items from both."""
    rooms = [{k: v for k, v in r.items() if k != "id"} for r in cvr.get("rooms", [])]
    out = {"rooms": rooms, "doors": cvr.get("doors", []), "furniture": [], "outdoor": None,
           "photo_corners": cvr.get("photo_corners"), "width_m": cvr.get("width_m"), "scale_note": cvr.get("scale_note"),
           "method": "image processing"}
    if not ai:
        return out
    out["method"] = "image processing + Claude vision"
    out["outdoor"] = ai.get("outdoor")
    out["furniture"] = [f for f in ai.get("furniture", []) if f["kind"] != "door"]
    if not out["photo_corners"] and ai.get("photo_corners"):
        out["photo_corners"] = ai["photo_corners"]
    if out["photo_corners"]:
        return out
    ai_rooms = ai.get("rooms", [])
    if len(rooms) < 2:
        # image processing found no usable walls: the vision model's outlines are the best we have
        out["rooms"] = [dict(r) for r in ai_rooms]
        out["method"] = "Claude vision"
        return out
    cm = [_raster(r["points"]).astype(np.int32) for r in rooms]
    am = [_raster(r["points"]).astype(np.int32) for r in ai_rooms]
    # name rooms that OCR could not read, from the vision room covering most of them
    claimed: dict[int, list[int]] = {}
    for i, c in enumerate(cm):
        ca = c.sum()
        if not ca:
            continue
        best = max(range(len(am)), key=lambda j: (c & am[j]).sum(), default=None)
        if best is not None and (c & am[best]).sum() >= 0.5 * ca:
            claimed.setdefault(best, []).append(i)
    for j, idx in claimed.items():
        idx.sort(key=lambda i: -cm[i].sum())
        for n, i in enumerate(idx):
            if re.fullmatch(r"Room \d+", rooms[i]["name"]):
                rooms[i]["name"] = ai_rooms[j]["name"] if n == 0 else f"{ai_rooms[j]['name']} {n + 1}"
    # rooms the image processing missed (no walls drawn, open areas): keep the vision outline
    cover = np.zeros_like(cm[0]) if cm else None
    for c in cm:
        cover |= c
    for j, a in enumerate(am):
        if a.sum() and (a & cover).sum() < 0.4 * a.sum():
            rooms.append({"name": ai_rooms[j]["name"], "points": ai_rooms[j]["points"], "source": "vision"})
    return out


def _crop(result: dict, crop: list[float]) -> None:
    """Move every coordinate in a result into the cropped image (fractions of the crop)."""
    x0, y0, x1, y1 = crop
    sx, sy = x1 - x0, y1 - y0
    for r in result["rooms"]:
        r["points"] = [[round((x - x0) / sx, 4), round((y - y0) / sy, 4)] for x, y in r["points"]]
    for f in result["doors"] + result["furniture"]:
        f["fx"] = round((f["fx"] - x0) / sx, 5); f["fy"] = round((f["fy"] - y0) / sy, 5)
        f["fw"] = round(f["fw"] / sx, 5); f["fd"] = round(f["fd"] / sx, 5)
    if result.get("outdoor"):
        result["outdoor"] = {"x": (result["outdoor"]["x"] - x0) / sx, "y": (result["outdoor"]["y"] - y0) / sy}
    if result.get("width_m"):
        result["width_m"] = round(result["width_m"] * sx * 2) / 2


FLOOR = re.compile(r"\b(ground|basement|mezzanine|roof|first|second|third|fourth|fifth|sixth|\d{1,2}(?:st|nd|rd|th)?)\s+(floor|level)\b"
                   r"|\b(level|floor)\s+(\d{1,2})\b", re.I)


def _floor_name(texts: list[str]) -> str | None:
    """The floor the sheet's title names ("GROUND FLOOR PLAN", "Level 3"), if any."""
    for t in texts:
        m = FLOOR.search(t)
        if m:
            return (m.group(0).strip().lower().capitalize())
    return None


def _jpeg(img: np.ndarray) -> str:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode() if ok else ""


def _known(pid: str, how: str) -> dict:
    return {"known": pid, "method": how, "rooms": [], "doors": [], "furniture": [], "outdoor": None,
            "photo_corners": None, "width_m": None, "scale_note": None}


async def analyze_plan(data_url: str) -> dict:
    media_type, data = _decode(data_url)
    try:
        img = plan_cv.decode(data)
    except ValueError as e:
        raise ParseError("Could not read this image") from e
    # a floor the platform already has a checked model of is built from that model
    pid = await asyncio.to_thread(known_plans.image_match, img)
    if pid:
        return _known(pid, "recognised from the drawing")
    cv_task = asyncio.to_thread(plan_cv.analyze, img)
    if ANTHROPIC_API_KEY:
        cvr, ai = await asyncio.gather(cv_task, vision(media_type, data), return_exceptions=True)
        if isinstance(ai, Exception):
            ai = None
        if isinstance(cvr, Exception):
            cvr = {"rooms": []}
    else:
        cvr, ai = await cv_task, None
    if not cvr.get("photo_corners"):
        pid = known_plans.text_match(cvr.get("_texts") or [])
        if pid:
            return _known(pid, "recognised from the room names")
    result = merge(cvr, ai)
    if not result["rooms"] and not result["photo_corners"]:
        raise ParseError("No rooms found on this image. Draw them by hand instead.")
    fl = _floor_name(cvr.get("_texts") or [])
    if fl:
        result["floor"] = fl
    if not result["photo_corners"]:
        # the 3D floor shows the building only: no title block, legend, notes or printed text
        clean = await asyncio.to_thread(plan_cv.clean_sheet, cvr, [r["points"] for r in result["rooms"]])
        if clean:
            if clean["apart"] and len(clean["apart"]) < len(result["rooms"]):
                result["rooms"] = [r for i, r in enumerate(result["rooms"]) if i not in set(clean["apart"])]
            _crop(result, clean["crop"])
            result["image"] = _jpeg(clean["image"])
            result["crop"] = [round(v, 4) for v in clean["crop"]]
    return result


async def detect_rooms(data_url: str) -> dict:
    """Kept for callers of the old name."""
    return await analyze_plan(data_url)
