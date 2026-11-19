"""Room detection on an uploaded floor plan image with Claude vision.

Returns axis-aligned room rectangles in 0..1 image coordinates. The user reviews and edits them
in the web editor before the 3D map is built, so mistakes here are cheap.
"""
import json
import re

from .config import ANTHROPIC_API_KEY, AGENT_MODEL

PROMPT = """This is an architectural floor plan. List every room as an axis-aligned rectangle.
Use coordinates as fractions of the image: x from 0 (left) to 1 (right), y from 0 (top) to 1 (bottom).
Use the room names printed on the plan when there are any; otherwise give a short plain name such as "Bedroom 2".
Include balconies and decks. Leave out wall thickness, furniture and dimension lines.
If an L-shaped room cannot be one rectangle, split it into two rectangles with the same name.
If the plan shows where the outdoor AC unit or the back yard is, give a point for it, else null.
Reply with JSON only:
{"rooms": [{"name": "Kitchen", "x0": 0.1, "y0": 0.2, "x1": 0.4, "y1": 0.5}], "outdoor": {"x": 0.5, "y": 1.05} | null}"""


class ParseError(RuntimeError):
    pass


def _clean(data: dict) -> dict:
    rooms = []
    for r in data.get("rooms", []):
        try:
            x0, x1 = sorted((float(r["x0"]), float(r["x1"])))
            y0, y1 = sorted((float(r["y0"]), float(r["y1"])))
        except (KeyError, TypeError, ValueError):
            continue
        x0, y0, x1, y1 = (max(-0.2, min(1.2, v)) for v in (x0, y0, x1, y1))
        if x1 - x0 < 0.02 or y1 - y0 < 0.02:
            continue
        rooms.append({"name": str(r.get("name") or "Room")[:40], "x0": round(x0, 4), "y0": round(y0, 4), "x1": round(x1, 4), "y1": round(y1, 4)})
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
