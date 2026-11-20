"""Room assistant for a hotel guest. It only sees and controls the guest's room: every call goes through the
platform's guest API (/api/guest/<token>/...), which checks the pass, the room and the allowed commands.

Flow: the guest asks ("Set the AC to 24 degrees and dim the lights", "make the room comfortable for sleeping").
The assistant works out which devices and commands that means, shows the plan, and either runs it at once
(a direct command) or asks first (a broader wish such as a sleep scene). Each device's result is reported,
including partial failures ("the lights are dimmed, but the AC did not respond: it is offline").

With ANTHROPIC_API_KEY set, Claude reads the request; without it a rule-based reader handles common requests
in English and Bangla. Both produce the same plan, which is checked against the room's allowed commands.
"""
import json
import re
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .config import ANTHROPIC_API_KEY, AGENT_MODEL, PLATFORM_URL

Event = tuple[str, dict]


class GuestPlatform:
    def __init__(self, token: str, cookie: str = "", base: str = PLATFORM_URL, client: httpx.AsyncClient | None = None):
        self.base = f"{base}/api/guest/{token}"
        self.headers = {"cookie": cookie} if cookie else {}
        self.client = client or httpx.AsyncClient(timeout=10)

    async def view(self) -> dict:
        r = await self.client.get(self.base, headers=self.headers)
        if r.status_code >= 400:
            raise RuntimeError(r.json().get("error", "This guest link can't be used."))
        return r.json()

    async def command(self, device_id: str, command: str, args: dict) -> dict:
        r = await self.client.post(f"{self.base}/devices/{device_id}/commands", json={"command": command, "args": args}, headers=self.headers)
        try:
            return r.json()
        except ValueError:
            return {"ok": False, "error": f"HTTP {r.status_code}"}


# ------------------------------------------------------------------ rule-based reader

BN_DIGITS = str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")
TYPE_WORDS = {
    "ac": r"\bac\b|a/c|air ?con|aircon|air condition|cooling|এসি",
    "light": r"light|lamp|বাতি|লাইট|আলো",
    "tv": r"\btv\b|television|টিভি",
    "fan": r"(?<!air )\bfan\b|ফ্যান|পাখা",
    "blinds": r"blind|curtain|shade|পর্দা",
    "purifier": r"purifier|air clean|পিউরিফায়ার",
    "vacuum": r"vacuum|robot|cleaner|ভ্যাকুয়াম",
    "lock": r"\block\b|\bdoor\b|দরজা|তালা",
}
ON = r"\bon\b|turn on|switch on|start|চালু|অন কর"
OFF = r"\boff\b|turn off|switch off|stop|বন্ধ|অফ কর"


def _num(text: str) -> float | None:
    m = re.search(r"(\d+(?:\.\d+)?)", text.translate(BN_DIGITS))
    return float(m.group(1)) if m else None


def _of(view: dict, t: str) -> list[dict]:
    return [d for d in view["devices"] if d["type"] == t]


def _can(d: dict, cmd: str) -> bool:
    return any(c["name"] == cmd for c in d.get("commands", []))


def _state(d: dict, key: str, default: Any = None) -> Any:
    return (d.get("overrides") or {}).get(key, (d.get("readings") or {}).get(key, default))


def _act(d: dict, cmd: str, args: dict, say: str) -> dict:
    return {"device_id": d["id"], "label": d["name"] or d["label"], "type": d["type"], "command": cmd, "args": args, "summary": say}


SCENES = {
    "sleep": r"sleep|bed ?time|good ?night|comfortable for sleep|ঘুম",
    "movie": r"movie|film|cinema|সিনেমা",
    "morning": r"wake|morning|good morning|সকাল",
    "away": r"leaving|going out|goodbye|check ?out|away|চলে যা|বাইরে যা",
    "hot": r"too hot|i'?m hot|feel hot|warm in here|গরম",
    "cold": r"too cold|i'?m cold|feel cold|chilly|ঠান্ডা লাগ",
    "clean": r"clean the room|clean my room|start cleaning|পরিষ্কার",
}


def scene_actions(name: str, view: dict) -> list[dict]:
    out: list[dict] = []
    for d in view["devices"]:
        t = d["type"]
        if name == "sleep":
            if t == "light" and _can(d, "setLevel"):
                out.append(_act(d, "setLevel", {"percent": 10 if "reading" in d["name"].lower() else 0}, "dim to a night glow" if "reading" in d["name"].lower() else "off"))
            elif t == "ac" and _can(d, "setTemperature"):
                out += [_act(d, "setMode", {"mode": "cool"}, "cool mode"), _act(d, "setTemperature", {"celsius": 24}, "24 °C"), _act(d, "setFanSpeed", {"percent": 35}, "quiet fan")]
            elif t == "blinds" and _can(d, "close"):
                out.append(_act(d, "close", {}, "close"))
            elif t == "tv" and _can(d, "power"):
                out.append(_act(d, "power", {"on": "false"}, "off"))
            elif t == "purifier" and _can(d, "setFan"):
                out.append(_act(d, "setFan", {"level": 1}, "quiet level 1"))
            elif t == "lock" and _can(d, "lock"):
                out.append(_act(d, "lock", {}, "lock the door"))
        elif name == "movie":
            if t == "light" and _can(d, "setLevel"):
                out.append(_act(d, "setLevel", {"percent": 15}, "dim to 15 %"))
            elif t == "tv" and _can(d, "power"):
                out.append(_act(d, "power", {"on": "true"}, "on"))
            elif t == "blinds" and _can(d, "close"):
                out.append(_act(d, "close", {}, "close"))
        elif name == "morning":
            if t == "blinds" and _can(d, "open"):
                out.append(_act(d, "open", {}, "open"))
            elif t == "light" and _can(d, "setLevel"):
                out += [_act(d, "setLevel", {"percent": 80}, "80 %"), _act(d, "setColorTemperature", {"kelvin": 5000}, "daylight white")]
        elif name == "away":
            if t in ("light",) and _can(d, "setLevel"):
                out.append(_act(d, "setLevel", {"percent": 0}, "off"))
            elif t in ("ac", "tv", "fan", "purifier") and _can(d, "power"):
                out.append(_act(d, "power", {"on": "false"}, "off"))
            elif t == "lock" and _can(d, "lock"):
                out.append(_act(d, "lock", {}, "lock the door"))
        elif name == "hot":
            if t == "ac" and _can(d, "setTemperature"):
                now = float(_state(d, "set", 24))
                out += [_act(d, "power", {"on": "true"}, "on"), _act(d, "setMode", {"mode": "cool"}, "cool mode"), _act(d, "setTemperature", {"celsius": max(18, int(now) - 2)}, f"{max(18, int(now) - 2)} °C")]
            elif t == "fan" and _can(d, "setSpeed"):
                out.append(_act(d, "setSpeed", {"level": 3}, "high"))
        elif name == "cold":
            if t == "ac" and _can(d, "setTemperature"):
                now = float(_state(d, "set", 24))
                out.append(_act(d, "setTemperature", {"celsius": min(30, int(now) + 2)}, f"{min(30, int(now) + 2)} °C"))
            elif t == "fan" and _can(d, "power"):
                out.append(_act(d, "power", {"on": "false"}, "off"))
        elif name == "clean":
            if t == "vacuum" and _can(d, "start"):
                out.append(_act(d, "start", {}, "start cleaning"))
    return out


def device_actions(clause: str, view: dict) -> tuple[list[dict], list[str]]:
    """Commands for one clause ("set the AC to 24 degrees", "dim the lights"). Returns (actions, problems)."""
    c = clause.lower()
    acts: list[dict] = []
    missing: list[str] = []
    n = _num(c)
    for t, pat in TYPE_WORDS.items():
        if not re.search(pat, c):
            continue
        devs = _of(view, t)
        if t == "light" and ("reading" in c or "ceiling" in c):
            devs = [d for d in devs if ("reading" in c) == ("reading" in d["name"].lower())] or devs
        if not devs:
            missing.append({"ac": "air conditioner", "tv": "TV", "light": "lights", "fan": "fan", "blinds": "blinds", "purifier": "air purifier", "vacuum": "robot vacuum", "lock": "door lock"}[t])
            continue
        for d in devs:
            if t == "ac":
                mode = next((m for m in ("cool", "heat", "dry", "fan", "auto") if re.search(rf"\b{m}\b", c)), None)
                if re.search(OFF, c):
                    acts.append(_act(d, "power", {"on": "false"}, "off"))
                    continue
                if re.search(ON, c) or n is not None or mode:
                    acts.append(_act(d, "power", {"on": "true"}, "on"))
                if mode and _can(d, "setMode"):
                    acts.append(_act(d, "setMode", {"mode": mode}, f"{mode} mode"))
                if n is not None and 16 <= n <= 30:
                    acts.append(_act(d, "setTemperature", {"celsius": int(round(n))}, f"{int(round(n))} °C"))
                if re.search(r"fan (speed )?(low|medium|high)|(low|medium|high) fan", c):
                    lvl = re.search(r"low|medium|high", c).group(0)
                    acts.append(_act(d, "setFanSpeed", {"percent": {"low": 30, "medium": 60, "high": 95}[lvl]}, f"{lvl} fan"))
                if re.search(r"swing", c) and _can(d, "setSwing"):
                    acts.append(_act(d, "setSwing", {"position": "swing"}, "swing louvers"))
                if (m := re.search(r"(\d+)\s*(hour|hr|ঘণ্টা)", c.translate(BN_DIGITS))) and _can(d, "setTimer"):
                    acts.append(_act(d, "setTimer", {"hours": min(12, int(m.group(1)))}, f"off in {m.group(1)} h"))
            elif t == "light":
                if re.search(r"dim|lower|softer|কম", c):
                    acts.append(_act(d, "setLevel", {"percent": int(n) if n is not None and n <= 100 else 30}, f"dim to {int(n) if n is not None and n <= 100 else 30} %"))
                elif re.search(r"bright|full|max|বাড়া|বেশি", c):
                    acts.append(_act(d, "setLevel", {"percent": int(n) if n is not None and n <= 100 else 100}, f"{int(n) if n is not None and n <= 100 else 100} %"))
                elif re.search(OFF, c):
                    acts.append(_act(d, "setLevel", {"percent": 0}, "off"))
                elif n is not None and n <= 100:
                    acts.append(_act(d, "setLevel", {"percent": int(n)}, f"{int(n)} %"))
                elif re.search(ON, c):
                    acts.append(_act(d, "setLevel", {"percent": 80}, "on (80 %)"))
                if re.search(r"warm|cozy|cosy|উষ্ণ", c):
                    acts.append(_act(d, "setColorTemperature", {"kelvin": 2700}, "warm white"))
                elif re.search(r"cool white|daylight|white light", c):
                    acts.append(_act(d, "setColorTemperature", {"kelvin": 5500}, "daylight white"))
            elif t == "tv":
                if re.search(OFF, c):
                    acts.append(_act(d, "power", {"on": "false"}, "off"))
                elif re.search(r"volume|sound|আওয়াজ", c) and n is not None:
                    acts.append(_act(d, "setVolume", {"percent": int(min(n, 100))}, f"volume {int(min(n, 100))}"))
                elif (m := re.search(r"hdmi ?(1|2)", c)):
                    acts.append(_act(d, "setInput", {"source": f"HDMI {m.group(1)}"}, f"HDMI {m.group(1)}"))
                else:
                    acts.append(_act(d, "power", {"on": "true"}, "on"))
            elif t == "fan":
                if re.search(OFF, c):
                    acts.append(_act(d, "power", {"on": "false"}, "off"))
                else:
                    lvl = 1 if re.search(r"low|slow", c) else 3 if re.search(r"high|fast|max", c) else (int(n) if n in (1.0, 2.0, 3.0) else 2)
                    acts.append(_act(d, "setSpeed", {"level": lvl}, f"speed {lvl}"))
                    if re.search(r"oscillat|swing|rotate", c):
                        acts.append(_act(d, "setOscillation", {"on": "true"}, "oscillate"))
            elif t == "blinds":
                if re.search(r"close|shut|down|বন্ধ", c):
                    acts.append(_act(d, "close", {}, "close"))
                elif n is not None and n <= 100:
                    acts.append(_act(d, "setPosition", {"percent": int(n)}, f"{int(n)} % open"))
                else:
                    acts.append(_act(d, "open", {}, "open"))
            elif t == "purifier":
                if re.search(OFF, c):
                    acts.append(_act(d, "power", {"on": "false"}, "off"))
                else:
                    lvl = int(n) if n is not None and 1 <= n <= 5 else 3
                    acts.append(_act(d, "setFan", {"level": lvl}, f"level {lvl}"))
            elif t == "vacuum":
                acts.append(_act(d, "dock", {}, "back to the dock") if re.search(r"dock|stop|home|বন্ধ", c) else _act(d, "start", {}, "start cleaning"))
            elif t == "lock":
                if re.search(r"unlock|open|খোল", c):
                    if _can(d, "unlock"):
                        acts.append(_act(d, "unlock", {}, "unlock"))
                    else:
                        missing.append("permission to unlock the door (ask the front desk)")
                else:
                    acts.append(_act(d, "lock", {}, "lock"))
    return acts, missing


def read_request(text: str, view: dict) -> dict:
    """Plan for a guest request: {actions, ask_first, scene, missing}."""
    low = text.lower()
    for name, pat in SCENES.items():
        if re.search(pat, low) and not re.search(r"\b(set|turn|switch|dim)\b", low):
            return {"actions": scene_actions(name, view), "ask_first": name not in ("clean",), "scene": name, "missing": []}
    acts: list[dict] = []
    missing: list[str] = []
    for clause in re.split(r"\band\b|,|;|\bthen\b|এবং|আর", low):
        a, m = device_actions(clause, view)
        acts += a
        missing += m
    for name, pat in SCENES.items():  # "it's too hot, set the fan high" style
        if not acts and re.search(pat, low):
            return {"actions": scene_actions(name, view), "ask_first": True, "scene": name, "missing": []}
    seen: set = set()
    uniq = []
    for a in acts:
        k = (a["device_id"], a["command"])
        if k not in seen:
            seen.add(k)
            uniq.append(a)
    return {"actions": uniq, "ask_first": False, "scene": None, "missing": missing}


# ------------------------------------------------------------------ wording

def is_bangla(text: str) -> bool:
    return bool(re.search(r"[ঀ-৿]", text))


SCENE_EN = {"sleep": "get the room ready for sleep", "movie": "set the room up for a movie", "morning": "brighten the room for the morning",
            "away": "switch things off while you're out", "hot": "cool the room down", "cold": "warm the room up", "clean": "start cleaning"}


def plan_text(plan: dict, bn: bool) -> str:
    acts = plan["actions"]
    if not acts:
        if plan["missing"]:
            return ("এই রুমে নেই: " if bn else "This room doesn't have ") + ", ".join(plan["missing"]) + "."
        return "দুঃখিত, বুঝতে পারিনি। যেমন বলুন: “এসি ২৪ ডিগ্রি করো”।" if bn else "Sorry, I didn't catch which device you mean. Try “set the AC to 24 degrees” or “dim the lights”."
    if plan["ask_first"]:
        what = SCENE_EN.get(plan["scene"], "do this")
        return ("আমি নিচের কাজগুলো করতে পারি। করব?" if bn else f"To {what}, I can do the following. Shall I go ahead?")
    return "করছি…" if bn else "On it:"


def result_text(results: list[dict], bn: bool) -> str:
    ok = [r for r in results if r["ok"]]
    bad = [r for r in results if not r["ok"]]
    parts = []
    if ok:
        names = sorted({r["label"] for r in ok})
        parts.append(("সম্পন্ন: " if bn else "Done: ") + ", ".join(names) + ".")
    for r in bad:
        if r.get("offline"):
            parts.append(f"{r['label']} সাড়া দেয়নি (অফলাইন)। স্টাফরা সতর্কবার্তা দেখছেন।" if bn else f"{r['label']} did not respond: it is offline. Hotel staff can see the alert.")
        else:
            parts.append(f"{r['label']}: {r['error']}")
    return " ".join(parts) or ("কিছু করা হয়নি।" if bn else "Nothing was changed.")


# ------------------------------------------------------------------ Claude reader

GUEST_SYSTEM = """You are the in-room assistant for a hotel guest. You can only use the devices listed for this room and only
the commands listed for each device. Turn the guest's request into device commands with the propose_actions tool.
Set ask_first=true for broad wishes (a mood or scene such as sleep, movie, "make it comfortable") and when anything
is uncertain; set ask_first=false for direct commands ("turn on the AC", "set it to 24"). If the room lacks a device
or a command is not allowed (for example unlocking), say so in `message`. Reply in the guest's language."""

PROPOSE_TOOL = {
    "name": "propose_actions",
    "description": "Commands to run for the guest, and a one-sentence message to them.",
    "input_schema": {
        "type": "object",
        "properties": {
            "actions": {"type": "array", "items": {"type": "object", "properties": {
                "device_id": {"type": "string"}, "command": {"type": "string"}, "args": {"type": "object"}, "summary": {"type": "string", "description": "What it does, 2-5 words"}},
                "required": ["device_id", "command"]}},
            "ask_first": {"type": "boolean"},
            "message": {"type": "string"},
        },
        "required": ["actions", "ask_first", "message"],
    },
}


async def claude_plan(messages: list[dict], view: dict) -> dict:
    from anthropic import AsyncAnthropic

    client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    room = [{"id": d["id"], "type": d["type"], "name": d["name"], "state": {k: d["readings"].get(k) for k in ("on", "set", "mode", "fan", "lv", "ct", "pos", "speed", "vol", "input", "state", "locked") if k in d["readings"]},
             "online": d.get("online", True), "commands": d["commands"]} for d in view["devices"]]
    system = GUEST_SYSTEM + f"\n\nRoom: {view['room']['name']}\nDevices: {json.dumps(room)}"
    convo = [{"role": m["role"], "content": m["content"]} for m in messages if m.get("content")]
    resp = await client.messages.create(model=AGENT_MODEL, max_tokens=800, system=system, tools=[PROPOSE_TOOL], tool_choice={"type": "tool", "name": "propose_actions"}, messages=convo)
    block = next(b for b in resp.content if b.type == "tool_use")
    data = dict(block.input)
    by_id = {d["id"]: d for d in view["devices"]}
    acts = []
    for a in data.get("actions", []):
        d = by_id.get(a.get("device_id"))
        if d and _can(d, a.get("command", "")):
            acts.append(_act(d, a["command"], a.get("args") or {}, a.get("summary") or a["command"]))
    return {"actions": acts, "ask_first": bool(data.get("ask_first")), "scene": None, "missing": [], "message": data.get("message", "")}


# ------------------------------------------------------------------ run

async def execute(platform: GuestPlatform, actions: list[dict]) -> list[dict]:
    """Runs the plan device by device; a device that fails (offline) doesn't stop the others."""
    results = []
    failed_devices: dict[str, dict] = {}
    for a in actions:
        if a["device_id"] in failed_devices:
            continue  # one report per device
        r = await platform.command(a["device_id"], a["command"], a.get("args") or {})
        if not r.get("ok"):
            failed_devices[a["device_id"]] = r
            results.append({**a, "ok": False, "error": r.get("error", "failed"), "offline": bool(r.get("offline"))})
        else:
            results.append({**a, "ok": True})
    # one line per device
    by_dev: dict[str, dict] = {}
    for r in results:
        cur = by_dev.get(r["device_id"])
        if cur is None:
            by_dev[r["device_id"]] = {**r, "summary": r["summary"]}
        elif r["ok"]:
            cur["summary"] += f", {r['summary']}"
    return list(by_dev.values())


async def run_guest(token: str, cookie: str, messages: list[dict], confirm: list[dict] | None = None) -> AsyncIterator[Event]:
    platform = GuestPlatform(token, cookie)
    last = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    bn = is_bangla(last)
    try:
        view = await platform.view()
        if confirm:
            allowed = {(d["id"], c["name"]) for d in view["devices"] for c in d["commands"]}
            acts = [a for a in confirm if (a.get("device_id"), a.get("command")) in allowed]
            results = await execute(platform, acts)
            yield "result", {"results": results}
            yield "ui_action", {"type": "highlight", "ids": [r["device_id"] for r in results]}
            yield "text", {"text": result_text(results, bn)}
            yield "done", {}
            return
        plan = await claude_plan(messages, view) if ANTHROPIC_API_KEY else read_request(last, view)
        msg = plan.get("message") or plan_text(plan, bn)
        yield "text", {"text": msg}
        if plan["actions"]:
            yield "plan", {"actions": plan["actions"], "ask_first": plan["ask_first"]}
            yield "ui_action", {"type": "highlight", "ids": sorted({a["device_id"] for a in plan["actions"]})}
            if not plan["ask_first"]:
                results = await execute(platform, plan["actions"])
                yield "result", {"results": results}
                yield "text", {"text": result_text(results, bn)}
    except Exception as e:  # surface to the chat instead of a dead stream
        yield "error", {"message": str(e)}
    yield "done", {}
