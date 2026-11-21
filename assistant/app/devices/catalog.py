"""Turns the raw, hard-coded SmartThings command lists into a compact "action" catalog.

Why: the frontend sends every command variant separately (an AC has ~22 entries such as
setAirConditionerMode("cool"), setAirConditionerMode("dry"), ...). Sending that raw JSON to a
small OSS model wastes context and invites invented commands. Instead we group variants into
actions with a closed set of options, e.g.

    - airConditionerMode.setAirConditionerMode: AC mode | value: one of [auto, cool, dry, ...]

The model only picks an action id + a value; code validates the value and rebuilds the exact
SmartThings command JSON from the original templates, so nothing the model writes is sent raw.

Argument conventions in the hard-coded command sets:
  * a plain word ("cool", "UP", "3")         -> a fixed option
  * a number (39)                            -> a free numeric value; the number is only an example
  * a sentence ("put an integer % here ...") -> a free value; the sentence is a hint for the model
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.core.context import Device

# Short human names for capabilities (shown to the model and used in replies). Extend freely.
CAPABILITY_LABELS: dict[str, str] = {
    "switch": "power",
    "switchLevel": "brightness / dimmer level",
    "thermostatCoolingSetpoint": "target temperature",
    "thermostatHeatingSetpoint": "heating temperature",
    "airConditionerMode": "AC mode",
    "airConditionerFanMode": "fan speed",
    "fanOscillationMode": "fan swing",
    "audioVolume": "volume",
    "audioMute": "mute",
    "tvChannel": "channel",
    "mediaInputSource": "input source",
    "samsungvd.remoteControl": "remote control button",
    "dryerOperatingState": "run / pause cycle",
    "washerOperatingState": "run / pause cycle",
    "colorControl": "light color",
    "colorTemperature": "light color temperature",
    "lock": "lock",
    "windowShade": "blinds / shade",
    "windowShadeLevel": "blinds / shade position",
}

COMMAND_LABELS: dict[tuple[str, str], str] = {
    ("switch", "on"): "turn on",
    ("switch", "off"): "turn off",
    ("audioVolume", "volumeUp"): "volume up",
    ("audioVolume", "volumeDown"): "volume down",
    ("audioVolume", "setVolume"): "set volume",
    ("tvChannel", "channelUp"): "next channel",
    ("tvChannel", "channelDown"): "previous channel",
    ("tvChannel", "setTvChannel"): "set channel",
    ("switchLevel", "setLevel"): "set brightness / dimmer level",
    ("thermostatCoolingSetpoint", "setCoolingSetpoint"): "set target temperature",
    ("airConditionerMode", "setAirConditionerMode"): "set AC mode",
    ("airConditionerFanMode", "setFanMode"): "set fan speed",
    ("samsungvd.remoteControl", "send"): "press a remote control button",
    ("dryerOperatingState", "setMachineState"): "run or pause the cycle",
    ("windowShade", "open"): "open",
    ("windowShade", "close"): "close",
    ("windowShadeLevel", "setShadeLevel"): "set blinds / shade position",
    ("colorTemperature", "setColorTemperature"): "set light color temperature",
}

# Deterministic confirmations ({device}, {value}). Missing pairs use GENERIC_CONFIRMATION.
CONFIRMATIONS: dict[tuple[str, str], str] = {
    ("switch", "on"): "Done! {device} is turned on.",
    ("switch", "off"): "Done! {device} is turned off.",
    ("airConditionerMode", "setAirConditionerMode"): "Done! {device} mode is set to {value}.",
    ("thermostatCoolingSetpoint", "setCoolingSetpoint"): "Done! {device} temperature is set to {value}°.",
    ("airConditionerFanMode", "setFanMode"): "Done! {device} fan speed is set to {value}.",
    ("switchLevel", "setLevel"): "Done! {device} brightness is set to {value}%.",
    ("audioVolume", "volumeUp"): "Done! Turned the volume up on {device}.",
    ("audioVolume", "volumeDown"): "Done! Turned the volume down on {device}.",
    ("tvChannel", "channelUp"): "Done! {device} switched to the next channel.",
    ("tvChannel", "channelDown"): "Done! {device} switched to the previous channel.",
    ("samsungvd.remoteControl", "send"): "Done! Pressed {value} on the {device} remote.",
    ("dryerOperatingState", "setMachineState"): "Done! {device} is set to {value}.",
    ("windowShade", "open"): "Done! {device} is opening.",
    ("windowShade", "close"): "Done! {device} is closing.",
    ("windowShadeLevel", "setShadeLevel"): "Done! {device} position is set to {value}%.",
    ("colorTemperature", "setColorTemperature"): "Done! {device} color temperature is set to {value}K.",
}
GENERIC_CONFIRMATION = "Done! {device}: {action}{value_part}."

# Past-tense phrases used when one reply covers several actions or devices ({device} may be
# "Light 1, Light 2 and Light 3"). Missing pairs use GENERIC_DONE_PHRASE.
DONE_PHRASES: dict[tuple[str, str], str] = {
    ("switch", "on"): "turned on {device}",
    ("switch", "off"): "turned off {device}",
    ("airConditionerMode", "setAirConditionerMode"): "set {device} mode to {value}",
    ("thermostatCoolingSetpoint", "setCoolingSetpoint"): "set {device} temperature to {value}°",
    ("airConditionerFanMode", "setFanMode"): "set {device} fan speed to {value}",
    ("switchLevel", "setLevel"): "set {device} brightness to {value}%",
    ("audioVolume", "volumeUp"): "turned the volume up on {device}",
    ("audioVolume", "volumeDown"): "turned the volume down on {device}",
    ("tvChannel", "channelUp"): "switched {device} to the next channel",
    ("tvChannel", "channelDown"): "switched {device} to the previous channel",
    ("samsungvd.remoteControl", "send"): "pressed {value} on the {device} remote",
    ("dryerOperatingState", "setMachineState"): "set {device} to {value}",
    ("windowShade", "open"): "opened {device}",
    ("windowShade", "close"): "closed {device}",
    ("windowShadeLevel", "setShadeLevel"): "set {device} position to {value}%",
    ("colorTemperature", "setColorTemperature"): "set {device} color temperature to {value}K",
}
GENERIC_DONE_PHRASE = "{action} for {device}{value_part}"

# Amount used for "a bit brighter" / "turn it up" when the user gives no number. Unlisted
# capabilities use 10% of the value's range, or 1 when the range is unknown.
DEFAULT_STEPS: dict[str, float] = {
    "switchLevel": 10,
    "windowShadeLevel": 10,
    "audioVolume": 5,
    "colorTemperature": 500,
    "thermostatCoolingSetpoint": 1,
    "thermostatHeatingSetpoint": 1,
    "fanSpeed": 1,
    "tvChannel": 1,
}


class ValueProblem(ValueError):
    """The value the model extracted cannot be used. `str(exc)` is a user-facing question."""


@dataclass
class ValueSlot:
    kind: str                     # "integer" | "number" | "string"
    hint: str                     # shown to the model
    template_args: list[Any]      # original arguments; the slot position gets replaced
    index: int                    # position of the free value inside template_args
    minimum: float | None = None
    maximum: float | None = None


@dataclass
class Action:
    id: str
    component: str
    capability: str
    command: str
    options: dict[str, list[Any]] = field(default_factory=dict)  # option label -> exact arguments
    slot: ValueSlot | None = None
    no_arg: bool = False  # a variant without arguments exists

    @property
    def needs_value(self) -> bool:
        return not self.no_arg and (bool(self.options) or self.slot is not None)

    @property
    def label(self) -> str:
        base = COMMAND_LABELS.get((self.capability, self.command)) or _humanize(self.command)
        return base if self.component == "main" else f"{base} ({self.component})"

    def describe(self) -> str:
        """One compact line for prompts."""
        line = f"- {self.id}: {self.label}"
        parts = []
        if self.options:
            parts.append("one of [" + ", ".join(self.options) + "]")
        if self.slot:
            s = self.slot
            rng = ""
            if s.minimum is not None and s.maximum is not None:
                rng = f" {s.minimum:g}-{s.maximum:g}"
            parts.append(f"{s.kind}{rng} ({s.hint})")
        if parts and not self.no_arg:
            line += " | value: " + " or ".join(parts)
        return line

    def resolve(self, raw: Any) -> tuple[list[Any], str]:
        """Validate the model's value. Returns (exact arguments, display value)."""
        if not self.needs_value:
            return [], ""
        text = "" if raw is None else str(raw).strip()
        if not text:
            raise ValueProblem(self.missing_value_question())

        if self.options:
            match = _match_option(text, list(self.options))
            if match is not None:
                return list(self.options[match]), match

        if self.slot:
            s = self.slot
            if s.kind == "string":
                value: Any = text
            else:
                m = re.search(r"-?\d+(?:\.\d+)?", text)
                if not m:
                    raise ValueProblem(self.missing_value_question())
                num = float(m.group())
                value = round(num) if s.kind == "integer" else num
                if (s.minimum is not None and num < s.minimum) or (s.maximum is not None and num > s.maximum):
                    raise ValueProblem(
                        f"The {self.label} must be between {s.minimum:g} and {s.maximum:g}. What value would you like?"
                    )
            args = list(s.template_args)
            args[s.index] = value
            return args, str(value)

        raise ValueProblem(
            f'"{text}" is not available for {self.label}. You can choose: {", ".join(self.options)}.'
        )

    # ---------- relative changes ("increase by 5", "a bit dimmer") ----------
    @property
    def can_step(self) -> bool:
        """True when the action takes a free number, so it can be raised or lowered from the current value."""
        return self.slot is not None and self.slot.kind != "string"

    def change_amount(self, raw: Any) -> tuple[float | None, bool]:
        """Parse the amount of an increase/decrease: (amount, given in %). amount None = default step."""
        if not self.can_step:
            raise ValueProblem(f"I can't change {self.label} by an amount. {self.missing_value_question()}")
        text = "" if raw is None else str(raw).strip()
        m = re.search(r"\d+(?:\.\d+)?", text)
        if not m:
            return None, False
        return float(m.group()), "%" in text

    def stepped(self, current: float, direction: int, amount: float | None, percent: bool) -> tuple[list[Any], str]:
        """Absolute arguments for current +/- amount, clamped to the allowed range. Returns (args, display value)."""
        s = self.slot
        assert s is not None
        span = s.maximum - s.minimum if s.minimum is not None and s.maximum is not None else None
        percent_scale = s.maximum == 100 and s.minimum is not None and 0 <= s.minimum <= 1
        if amount is None:
            amount = DEFAULT_STEPS.get(self.capability) or (span / 10 if span else 1)
        elif percent and span and not percent_scale:
            amount = amount * span / 100  # "5%" on a non-percent value = 5% of its range
        target = current + direction * amount
        if s.minimum is not None:
            target = max(target, s.minimum)
        if s.maximum is not None:
            target = min(target, s.maximum)
        value: Any = round(target) if s.kind == "integer" else round(target, 1)
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        args = list(s.template_args)
        args[s.index] = value
        return args, str(value)

    def missing_value_question(self) -> str:
        if self.options:
            return f"Which option would you like for {self.label}? You can choose: {', '.join(self.options)}."
        if self.slot and self.slot.minimum is not None:
            return f"What value would you like for {self.label} ({self.slot.minimum:g}-{self.slot.maximum:g})?"
        return f"What value would you like for {self.label}?"

    def build(self, args: list[Any]) -> dict[str, Any]:
        return {"component": self.component, "capability": self.capability, "command": self.command, "arguments": args}

    def confirmation(self, device_name: str, value: str) -> str:
        tpl = CONFIRMATIONS.get((self.capability, self.command))
        if tpl:
            return tpl.format(device=device_name, value=value)
        return GENERIC_CONFIRMATION.format(
            device=device_name, action=self.label, value_part=f" ({value})" if value else ""
        )

    def done_phrase(self, devices_text: str, value: str) -> str:
        """Past-tense fragment for combined replies, e.g. "set Light 1 and Light 2 brightness to 40%"."""
        tpl = DONE_PHRASES.get((self.capability, self.command))
        if tpl:
            return tpl.format(device=devices_text, value=value)
        return GENERIC_DONE_PHRASE.format(
            device=devices_text, action=self.label, value_part=f" ({value})" if value else ""
        )


def _humanize(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", " ", name.split(".")[-1]).lower()


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _match_option(text: str, options: list[str]) -> str | None:
    t = _norm(text)
    exact = [o for o in options if _norm(o) == t]
    if exact:
        return exact[0]
    # tolerate "cooling" -> "cool", "turbo mode" -> "turbo" when unambiguous
    loose = [o for o in options if len(_norm(o)) >= 3 and (t.startswith(_norm(o)) or _norm(o).startswith(t))]
    return loose[0] if len(loose) == 1 else None


def _is_hint(arg: Any) -> bool:
    return isinstance(arg, str) and len(arg) > 12 and " " in arg.strip()


def _slot_for(args: list[Any]) -> ValueSlot | None:
    for i, a in enumerate(args):
        if isinstance(a, bool):
            continue
        if isinstance(a, (int, float)):
            kind = "integer" if isinstance(a, int) else "number"
            return ValueSlot(kind=kind, hint=f"e.g. {a}", template_args=list(args), index=i)
        if _is_hint(a):
            low = a.lower()
            kind = "integer" if ("integer" in low or "%" in low or "number" in low) else "string"
            slot = ValueSlot(kind=kind, hint=a.strip(), template_args=list(args), index=i)
            if "%" in low:
                slot.minimum, slot.maximum = 0, 100
            rng = re.search(r"range\s+(-?\d+(?:\.\d+)?)\s+to\s+(-?\d+(?:\.\d+)?)", low)
            if rng:
                slot.minimum, slot.maximum = float(rng.group(1)), float(rng.group(2))
            return slot
    return None


def build_actions(device: Device) -> list[Action]:
    actions: dict[tuple[str, str, str], Action] = {}
    for cmd in device.commands:
        capability, command = cmd.get("capability"), cmd.get("command")
        if not capability or not command:
            continue
        component = cmd.get("component") or "main"
        args = list(cmd.get("arguments") or [])
        if any(isinstance(a, (dict, list)) for a in args):
            continue  # needs several values at once (e.g. setColor hue + saturation); not supported in chat yet
        key = (component, capability, command)
        if key not in actions:
            aid = f"{capability}.{command}" + ("" if component == "main" else f"@{component}")
            actions[key] = Action(id=aid, component=component, capability=capability, command=command)
        act = actions[key]
        slot = _slot_for(args)
        if slot:
            act.slot = act.slot or slot
        elif not args:
            act.no_arg = True
        else:
            act.options.setdefault(" ".join(str(a) for a in args), args)
    return list(actions.values())


def capability_summary(device: Device) -> str:
    seen: list[str] = []
    for cmd in device.commands:
        cap = cmd.get("capability", "")
        label = CAPABILITY_LABELS.get(cap) or _humanize(cap)
        if label and label not in seen:
            seen.append(label)
    return ", ".join(seen) or "no controls"


def device_line(device: Device) -> str:
    room = f" (room: {device.room})" if device.room else ""
    return f"- {device.name}{room}: {capability_summary(device)}"
