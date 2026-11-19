"""Room detection on an uploaded floor plan image with Claude vision.

Returns each room as a polygon (its outline, any shape) in 0..1 image coordinates. The user reviews and edits them
in the web editor before the 3D map is built, so mistakes here are cheap.
"""
import json
import re

from .config import ANTHROPIC_API_KEY, AGENT_MODEL

PROMPT = """This is an architectural floor plan. Trace every room as a polygon following the inside face of its walls.
Rooms are often not rectangles: L-shapes, angled walls, bay windows and notches must be traced corner by corner.
Use coordinates as fractions of the image: x from 0 (left) to 1 (right), y from 0 (top) to 1 (bottom).
List corners in order around the room (clockwise), without repeating the first corner. Use as many corners as the shape needs; a plain rectangle has 4.
Neighbouring rooms should share their wall lines: give the same coordinates for the same wall.
Use the room names printed on the plan when there are any; otherwise a short plain name such as "Bedroom 2". Include balconies and decks.
Leave out furniture, door swings and dimension lines.
If the plan shows where the outdoor AC unit or the back yard is, give a point for it, else null.
Reply with JSON only:
{"rooms": [{"name": "Kitchen", "points": [[0.1, 0.2], [0.4, 0.2], [0.4, 0.5], [0.1, 0.5]]}], "outdoor": {"x": 0.5, "y": 1.05}}"""


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
    return {"rooms": rooms[:60], "outdoor": outdoor}


def parse_json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ParseError("The model did not return JSON")
    try:
        return _clean(json.loads(m.group(0)))
    except json.JSONDecodeError as e:
        raise ParseError(f"Bad JSON from the model: {e}") from e


async def detect_rooms(data_url: str) -> dict:
    if not ANTHROPIC_API_KEY:
        raise ParseError("Room detection needs ANTHROPIC_API_KEY in agent-backend/.env. Draw the rooms by hand instead.")
    m = re.match(r"^data:(image/(?:png|jpeg|webp|gif));base64,(.+)$", data_url, re.S)
    if not m:
        raise ParseError("image must be a base64 data URL (PNG, JPEG, WebP or GIF)")
    from anthropic import AsyncAnthropic

    client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    resp = await client.messages.create(
        model=AGENT_MODEL,
        max_tokens=2000,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": m.group(1), "data": m.group(2)}},
            {"type": "text", "text": PROMPT},
        ]}],
    )
    text = "".join(b.text for b in resp.content if b.type == "text")
    result = parse_json(text)
    if not result["rooms"]:
        raise ParseError("No rooms found on this image. Draw them by hand instead.")
    return result
