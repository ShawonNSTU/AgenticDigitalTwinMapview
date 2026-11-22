"""Fast lane: plain, complete device commands are understood without the model.

"turn on Light 1", "Light 2 off", "dim the Desk Lamp to 30%", "set Ceiling AC to 24", "open the Aqara Roller Shade
Controller" name exactly one device and say exactly what to do, so code can map them to the device's own action as
surely as the model would, in microseconds instead of seconds. Anything else (several devices, relative changes,
feelings, conditions, a name that isn't a device, a value a device can't take) returns None and goes the usual way
through the router and the model: the fast lane never guesses.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from app.core.context import Device
from app.devices.catalog import Action, ValueProblem, build_actions
from app.devices.matching import exact_matches

# words that make a request more than one plain command
_NOT_PLAIN = re.compile(
    r"\b(all|every|everything|both|each|and|also|plus|except|other|others|rest|if|when|unless|then|after|before|"
    r"until|by|bit|little|more|less|brighter|dimmer|warmer|cooler|up|down|increase|decrease|raise|lower|"
    r"too|so|because|why|what|how|which|is|are|was|does|do|can|could|should|would|not|don't|dont|never|"
    r"save|routine|schedule|every|tonight|tomorrow|later|minutes?|hours?|seconds?)\b|[,&?]", re.I)

_FILL = r"(?:please\s+)?(?:can you\s+)?(?:the\s+)?"


@dataclass
class Direct:
    device: Device
    action_id: str
    value: str          # "" when the action takes none


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w%°.\s-]", " ", text.lower())).strip()


def direct(request: str, devices: list[Device]) -> Direct | None:
    """The one plain command in this request, or None."""
    hits = exact_matches(request, devices)
    if len(hits) != 1:
        return None
    dev = hits[0]
    text = _norm(request)
    name = _norm(dev.name)
    if name not in text:
        return None
    rest = text.replace(name, " <dev> ", 1)
    if _NOT_PLAIN.search(rest.replace("<dev>", "")):
        return None
    rest = re.sub(r"\s+", " ", rest).strip(" .")
    rest = re.sub(r"\bplease\b", "", rest).strip()
    rest = re.sub(r"\s+", " ", rest)
    acts = {a.id: a for a in build_actions(dev)}

    def pick(aid: str, value: str = "") -> Direct | None:
        a = acts.get(aid)
        if a is None:
            return None
        if value or a.needs_value:
            try:
                a.resolve(value)
            except ValueProblem:
                return None
        return Direct(dev, aid, value)

    m = re.fullmatch(rf"(?:turn|switch|power)\s+(on|off)\s+{_FILL}<dev>|{_FILL}<dev>\s+(on|off)|(?:turn|switch|power)\s+{_FILL}<dev>\s+(on|off)", rest)
    if m:
        return pick(f"switch.{m.group(1) or m.group(2) or m.group(3)}")
    m = re.fullmatch(rf"(open|close|shut)\s+{_FILL}<dev>", rest)
    if m:
        verb = "close" if m.group(1) in ("close", "shut") else "open"
        return pick(f"windowShade.{verb}") or pick("windowShadeLevel.setShadeLevel", "0" if verb == "close" else "100")
    m = re.fullmatch(rf"(?:lock|unlock)\s+{_FILL}<dev>", rest)
    if m:
        return None   # door locks keep their own checks (step-up PIN, policy): never the fast lane
    num = r"(\d{1,3}(?:\.\d)?)"
    m = re.fullmatch(rf"(?:set|dim|brighten|change|put)\s+{_FILL}<dev>(?:\s+(?:brightness|level))?\s+(?:to|at)\s+{num}\s*%|{_FILL}<dev>\s+(?:brightness\s+)?(?:to\s+)?{num}\s*%", rest)
    if m:
        v = m.group(1) or m.group(2)
        return pick("switchLevel.setLevel", v) or pick("windowShadeLevel.setShadeLevel", v)
    m = re.fullmatch(rf"(?:set|change|put)\s+{_FILL}<dev>(?:\s+temperature)?\s+(?:to|at)\s+{num}\s*(?:°\s*c|degrees?(?:\s+c(?:elsius)?)?|c)?|{_FILL}<dev>\s+(?:to\s+)?{num}\s*(?:°\s*c|degrees?(?:\s+c(?:elsius)?)?)", rest)
    if m:
        v = m.group(1) or m.group(2)
        cool = pick("thermostatCoolingSetpoint.setCoolingSetpoint", v)
        level = acts.get("switchLevel.setLevel")
        if cool and level:
            return None   # a number could mean either: ask the model
        return cool or (pick("switchLevel.setLevel", v) if "°" not in rest and "degree" not in rest else None)
    return None


def action_of(d: Direct) -> Action:
    return {a.id: a for a in build_actions(d.device)}[d.action_id]
