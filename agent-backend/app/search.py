"""Natural-language device search over the floor snapshot.

Deterministic on purpose: the LLM decides *what* to look for, this decides *which ids match*,
so highlights on the map are always backed by real data.
"""
import re

TYPE_WORDS: dict[str, list[str]] = {
    "ac": ["ac", "acs", "air conditioner", "air conditioners", "aircon", "air con", "indoor unit", "indoor units", "hvac", "cooling", "cooler"],
    "odu": ["outdoor unit", "outdoor", "odu", "compressor", "condenser", "heat pump", "hvac"],
    "light": ["light", "lights", "lamp", "lamps", "bulb", "bulbs", "lighting"],
    "blinds": ["blind", "blinds", "shade", "shades", "curtain", "curtains"],
    "plug": ["plug", "plugs", "socket", "sockets", "outlet", "outlets", "smart plug"],
    "lock": ["lock", "locks", "door lock", "smart lock"],
    "camera": ["camera", "cameras", "cctv", "cam"],
    "doorbell": ["doorbell", "door bell", "bell"],
    "motion": ["motion", "motion sensor", "presence", "occupancy"],
    "leak": ["leak", "leak sensor", "water sensor", "flood"],
    "temphum": ["temperature sensor", "humidity", "thermometer", "climate sensor", "temp sensor"],
    "tv": ["tv", "television", "tvs"],
    "speaker": ["speaker", "speakers", "sound"],
    "fridge": ["fridge", "refrigerator", "freezer"],
    "oven": ["oven", "stove", "range", "cooktop"],
    "washer": ["washer", "washing machine", "laundry"],
    "dryer": ["dryer", "tumble dryer"],
    "purifier": ["purifier", "air purifier"],
    "vacuum": ["vacuum", "robot vacuum", "robot cleaner"],
}
HEALTH_WORDS: dict[str, list[str]] = {
    "fault": ["fault", "faulty", "broken", "error", "failed", "failing", "critical", "down"],
    "watch": ["warning", "watch", "degraded", "check"],
    "problem": ["problem", "problems", "issue", "issues", "alert", "alerts", "attention", "unhealthy", "not ok", "bad"],
    "ok": ["healthy", "ok", "fine", "normal", "working"],
}
CATEGORY: dict[str, list[str]] = {
    "hvac": ["ac", "odu", "purifier", "temphum"],
    "security": ["lock", "camera", "doorbell", "motion"],
    "appliance": ["fridge", "oven", "washer", "dryer", "vacuum"],
    "entertainment": ["tv", "speaker"],
}


def _has(text: str, phrase: str) -> bool:
    return re.search(rf"(?<![a-z0-9]){re.escape(phrase)}(?![a-z0-9])", text) is not None


def parse(query: str, rooms: list[dict]) -> dict:
    """Return {'types', 'rooms', 'health', 'ids'} found in the query."""
    q = " " + query.lower().replace("-", " ").replace("_", " ") + " "
    ids = re.findall(r"\b([a-z]{2,4})[ -]?(\d{2})\b", query.lower())
    types = {t for t, words in TYPE_WORDS.items() if any(_has(q, w) for w in words)}
    for cat, members in CATEGORY.items():
        if _has(q, cat):
            types |= set(members)
    def phrases(r: dict) -> set[str]:
        name = r["name"].lower()
        base = re.sub(r"\(.*?\)", "", name).strip()          # "training room 403 (sajek)" -> "training room 403"
        out = {name, base, r["key"].lower().replace("-", " "), re.sub(r"\s*\d+$", "", base).strip()}
        out |= {m.strip() for m in re.findall(r"\((.*?)\)", name)}  # nickname in brackets: "sajek"
        return {x for x in out if len(x) >= 3}
    room_keys = {r["key"] for r in rooms if any(_has(q, ph) for ph in phrases(r))}
    if _has(q, "bedroom") and not _has(q, "primary"):
        room_keys.discard("primary")
    health = None
    for h, words in HEALTH_WORDS.items():
        if any(_has(q, w) for w in words):
            health = h
            break
    return {"types": sorted(types), "rooms": sorted(room_keys), "health": health, "ids": [f"{a.upper()}-{b}" for a, b in ids]}


def search(query: str, floor: dict, type: str | None = None, room: str | None = None, health: str | None = None) -> dict:
    """Match devices by explicit filters first, then by words in the query."""
    devices, rooms = floor["devices"], floor["rooms"]
    p = parse(query or "", rooms)
    known = {d["id"].upper(): d["id"] for d in devices}
    # ids as written on a drawing (e.g. 2FX1C07, CAM-03) or in the AC-04 style
    tokens = {t.upper() for t in re.findall(r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?", query or "")}
    explicit_ids = [known[i] for i in dict.fromkeys(p["ids"] + sorted(tokens)) if i in known]
    types = [type] if type else p["types"]
    room_keys = [room] if room else p["rooms"]
    want = health or p["health"]

    def ok(d: dict) -> bool:
        if types and d["type"] not in types:
            return False
        if room_keys and d["room"] not in room_keys:
            return False
        if want == "problem" and d["health"] == "ok":
            return False
        if want in ("ok", "watch", "fault") and d["health"] != want:
            return False
        return True

    if explicit_ids:
        # An id names the device; words like "ac" in "AC-05" must not widen the match.
        hits = [d for d in devices if d["id"] in explicit_ids]
    elif not (types or room_keys or want):
        # Fall back to plain word overlap with names, so "smart tv in kitchen" style queries still work.
        words = [w for w in re.findall(r"[a-z]{3,}", (query or "").lower()) if w not in {"show", "find", "the", "all", "and", "with", "where", "devices", "device"}]
        hits = [d for d in devices if any(w in d["name"].lower() for w in words)]
    else:
        hits = [d for d in devices if ok(d)]
    return {
        "query": query,
        "understood": {"types": types, "rooms": room_keys, "health": want, "ids": explicit_ids},
        "count": len(hits),
        "devices": [{"id": d["id"], "label": d["label"], "room": d["room"], "health": d["health"]} for d in hits],
    }
