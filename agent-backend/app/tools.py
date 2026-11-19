"""Tools the agent can call. Each returns (result_for_model, events_for_ui).

Events are streamed to the web app:
  ("ui_action", {...})  forwarded to the Godot renderer (see docs/contracts/bridge-api.md)
  ("select", {"id": ...}) opens the device in the side panel
"""
from typing import Any
from .platform import Platform, PlatformError
from .search import search

Event = tuple[str, dict]

TOOLS: list[dict] = [
    {
        "name": "search_devices",
        "description": "Find devices on the floor from a natural-language query (type, room, health, or ids such as AC-04). "
        "Matching devices are highlighted on the 3D map unless highlight=false. Use the explicit filters when you are sure.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What the user is looking for, e.g. 'air conditioners with a problem in the bedroom'"},
                "type": {"type": "string", "description": "Optional exact device type: ac, odu, light, blinds, plug, lock, camera, doorbell, motion, leak, temphum, tv, speaker, fridge, oven, washer, dryer, purifier, vacuum"},
                "room": {"type": "string", "description": "Optional room key from get_floor_summary"},
                "health": {"type": "string", "enum": ["ok", "watch", "fault", "problem"], "description": "'problem' means watch or fault"},
                "highlight": {"type": "boolean", "default": True},
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_floor_summary",
        "description": "Rooms, device counts, current simulated time and scenario, and every device that is not healthy with its finding title.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_device_insights",
        "description": "Live readings, part-level health, the current finding (evidence, confidence, guided steps) and supported commands for one device.",
        "input_schema": {"type": "object", "properties": {"device_id": {"type": "string"}}, "required": ["device_id"]},
    },
    {
        "name": "get_part_history",
        "description": "Today's history of one part of a device (06:00 to 22:00), summarised as start, now, min, max and when it changed most.",
        "input_schema": {"type": "object", "properties": {"device_id": {"type": "string"}, "part": {"type": "string", "description": "Part key from get_device_insights"}}, "required": ["device_id", "part"]},
    },
    {
        "name": "control_device",
        "description": "Send a whitelisted command to a device. Some commands (unlock, washer stop) need confirmed=true, which you may only set "
        "after the user has explicitly said yes to that exact action in their latest message.",
        "input_schema": {
            "type": "object",
            "properties": {
                "device_id": {"type": "string"},
                "command": {"type": "string"},
                "args": {"type": "object", "description": "Command arguments, e.g. {\"celsius\": 24}"},
                "confirmed": {"type": "boolean", "default": False},
            },
            "required": ["device_id", "command"],
        },
    },
    {
        "name": "show_on_map",
        "description": "Drive the 3D map: highlight devices, fly to one, open it to show its internal parts (optionally focusing a part), "
        "trace its refrigerant circuit, clear highlights or reset the camera.",
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["highlight", "focus", "open", "trace", "clear", "reset"]},
                "device_ids": {"type": "array", "items": {"type": "string"}},
                "part": {"type": "string"},
            },
            "required": ["action"],
        },
    },
    {
        "name": "set_map_view",
        "description": "Change what the map shows: toggle a layer, switch the demo scenario, or move the simulated clock (hours 6 to 22).",
        "input_schema": {
            "type": "object",
            "properties": {
                "layer": {"type": "string", "enum": ["devices", "piping", "names", "ids", "temperature"]},
                "on": {"type": "boolean"},
                "scenario": {"type": "string", "description": "normal, filter, refrig or washer"},
                "time": {"type": "number"},
            },
        },
    },
]


def _brief(d: dict) -> dict:
    """Trim a device snapshot to what the model needs."""
    f = d.get("finding")
    return {
        "id": d["id"], "label": d["label"], "room": d["room"], "health": d["health"],
        "parts": [{k: p[k] for k in ("key", "name", "value", "health", "inferred")} for p in d.get("parts", [])],
        "finding": None if not f else {k: f.get(k) for k in ("lvl", "title", "conf", "ev", "steps", "trace")},
        "overrides": d.get("overrides"),
    }


async def run_tool(name: str, args: dict[str, Any], platform: Platform) -> tuple[Any, list[Event]]:
    ev: list[Event] = []
    try:
        if name == "search_devices":
            floor = await platform.floor()
            res = search(args.get("query", ""), floor, args.get("type"), args.get("room"), args.get("health"))
            ids = [d["id"] for d in res["devices"]]
            if args.get("highlight", True):
                ev.append(("ui_action", {"type": "highlight", "ids": ids, "reason": args.get("query", "")} if ids else {"type": "clearHighlight"}))
            return res, ev

        if name == "get_floor_summary":
            floor, sim = await platform.floor(), await platform.sim()
            bad = [d for d in floor["devices"] if d["health"] != "ok"]
            details = []
            for d in bad:
                full = await platform.device(d["id"])
                details.append({"id": d["id"], "label": d["label"], "room": d["room"], "health": d["health"], "finding": (full.get("finding") or {}).get("title")})
            by_type: dict[str, int] = {}
            for d in floor["devices"]:
                by_type[d["type"]] = by_type.get(d["type"], 0) + 1
            return {
                "time": sim["t"], "scenario": sim["scenario"],
                "rooms": [{"key": r["key"], "name": r["name"]} for r in floor["rooms"]],
                "device_count": len(floor["devices"]), "by_type": by_type, "not_healthy": details,
            }, ev

        if name == "get_device_insights":
            d = await platform.device(args["device_id"])
            out = _brief(d)
            out["commands"] = (await platform.commands(args["device_id"])).get("commands", [])
            return out, ev

        if name == "get_part_history":
            h = await platform.history(args["device_id"], args["part"])
            pts = h.get("points", [])
            if not pts:
                return {"error": "no history"}, ev
            vals = [v for _, v in pts]
            jumps = [(pts[i][0], pts[i][1] - pts[i - 1][1]) for i in range(1, len(pts))]
            biggest = max(jumps, key=lambda j: abs(j[1])) if jumps else (pts[0][0], 0)
            now = h.get("now", pts[-1][0])
            upto = [p for p in pts if p[0] <= now] or pts[:1]
            return {"part": args["part"], "unit": h.get("unit", ""), "start": upto[0], "now": upto[-1], "min": min(vals), "max": max(vals), "largest_change_at": biggest[0]}, ev

        if name == "control_device":
            res = await platform.command(args["device_id"], args["command"], args.get("args") or {}, bool(args.get("confirmed")))
            if res.get("ok"):
                ev.append(("ui_action", {"type": "highlight", "ids": [args["device_id"]], "reason": f"{args['command']} sent"}))
                res["device"] = _brief(res["device"])
            elif res.get("needsConfirmation"):
                res["instruction"] = "Ask the user to confirm this exact action. Do not retry with confirmed=true in this turn."
            return res, ev

        if name == "show_on_map":
            a, ids, part = args["action"], args.get("device_ids") or [], args.get("part")
            if a == "highlight":
                ev.append(("ui_action", {"type": "highlight", "ids": ids}))
            elif a == "clear":
                ev.append(("ui_action", {"type": "clearHighlight"}))
            elif a == "reset":
                ev.append(("ui_action", {"type": "resetView"}))
            elif not ids:
                return {"error": f"'{a}' needs one device id"}, ev
            elif a == "focus":
                ev.append(("ui_action", {"type": "focusDevice", "id": ids[0]}))
            elif a == "open":
                ev.append(("ui_action", {"type": "openDevice", "id": ids[0], **({"part": part} if part else {})}))
                ev.append(("select", {"id": ids[0]}))
            elif a == "trace":
                ev.append(("ui_action", {"type": "trace", "from": ids[0]}))
            return {"ok": True, "action": a, "device_ids": ids}, ev

        if name == "set_map_view":
            out: dict[str, Any] = {"ok": True}
            if args.get("layer"):
                ev.append(("ui_action", {"type": "setLayer", "layer": args["layer"], "on": args.get("on", True)}))
            if args.get("scenario") or args.get("time") is not None:
                out["sim"] = await platform.set_sim(scenario=args.get("scenario"), t=args.get("time"))
            return out, ev

        return {"error": f"unknown tool {name}"}, ev
    except PlatformError as e:
        return {"error": str(e)}, ev
    except KeyError as e:
        return {"error": f"missing argument {e}"}, ev
