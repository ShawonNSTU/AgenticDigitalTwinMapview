"""Live device state: read SmartThings /status + /health and turn them into short, readable facts.

Status shape: {"components": {component: {capability: {attribute: {"value": ..., "unit": ...}}}}}.
We read the standard capability attributes directly (see READINGS) instead of the frontend's
presentation paths: the agent knows each device's capabilities from its command set, and the
standard attributes are the same values the guest page shows.

Nothing here calls the LLM. Skills put `DeviceState.line()` into a prompt (device_status) or
read one number with `DeviceState.number()` (relative changes in device_control).
"""
from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import Any

from app.core.context import Device
from app.integrations.smartthings import SmartThingsClient

# (capability, attribute) -> label, in the order readings are listed. Extend freely.
READINGS: dict[tuple[str, str], str] = {
    ("switch", "switch"): "power",
    ("switchLevel", "level"): "brightness",
    ("colorTemperature", "colorTemperature"): "color temperature",
    ("colorControl", "hue"): "color hue",
    ("colorControl", "saturation"): "color saturation",
    ("windowShade", "windowShade"): "shade",
    ("windowShadeLevel", "shadeLevel"): "open",
    ("temperatureMeasurement", "temperature"): "temperature",
    ("relativeHumidityMeasurement", "humidity"): "humidity",
    ("thermostatCoolingSetpoint", "coolingSetpoint"): "target temperature",
    ("thermostatHeatingSetpoint", "heatingSetpoint"): "heating temperature",
    ("airConditionerMode", "airConditionerMode"): "AC mode",
    ("airConditionerFanMode", "fanMode"): "fan mode",
    ("fanSpeed", "fanSpeed"): "fan speed",
    ("fanOscillationMode", "fanOscillationMode"): "fan swing",
    ("audioVolume", "volume"): "volume",
    ("audioMute", "mute"): "mute",
    ("tvChannel", "tvChannel"): "channel",
    ("tvChannel", "tvChannelName"): "channel name",
    ("mediaInputSource", "inputSource"): "input source",
    ("lock", "lock"): "lock",
    ("doorControl", "door"): "door",
    ("contactSensor", "contact"): "contact",
    ("motionSensor", "motion"): "motion",
    ("presenceSensor", "presence"): "presence",
    ("illuminanceMeasurement", "illuminance"): "light level",
    ("carbonDioxideMeasurement", "carbonDioxide"): "CO2",
    ("airQualitySensor", "airQuality"): "air quality",
    ("washerOperatingState", "machineState"): "washer state",
    ("dryerOperatingState", "machineState"): "dryer state",
    ("powerMeter", "power"): "power use",
    ("energyMeter", "energy"): "energy use",
    ("battery", "battery"): "battery",
    ("waterSensor", "water"): "water leak",
    ("ovenOperatingState", "machineState"): "oven state",
    ("ovenSetpoint", "ovenSetpoint"): "oven setpoint",
    ("robotCleanerMovement", "robotCleanerMovement"): "cleaning",
    ("robotCleanerCleaningMode", "robotCleanerCleaningMode"): "cleaning mode",
    ("airPurifierFanMode", "airPurifierFanMode"): "purifier fan",
    ("dustSensor", "fineDustLevel"): "PM2.5",
    ("refrigeration", "rapidCooling"): "rapid cooling",
}
# Unit used when the status has none.
DEFAULT_UNITS: dict[tuple[str, str], str] = {
    ("switchLevel", "level"): "%",
    ("windowShadeLevel", "shadeLevel"): "%",
    ("colorTemperature", "colorTemperature"): "K",
    ("relativeHumidityMeasurement", "humidity"): "%",
    ("battery", "battery"): "%",
}
# The attribute a setter command changes. Unlisted "setFooBar" commands map to "fooBar".
SETTER_ATTRIBUTES: dict[tuple[str, str], str] = {
    ("switchLevel", "setLevel"): "level",
    ("audioVolume", "setVolume"): "volume",
    ("tvChannel", "setTvChannel"): "tvChannel",
    ("airConditionerFanMode", "setFanMode"): "fanMode",
}
UNIT_TEXT = {"C": "°C", "F": "°F"}
TIGHT_UNITS = {"%", "°C", "°F", "K", "°"}
MAX_EXTRA_PER_CAPABILITY = 2  # readings for unlisted capabilities the device is controlled with
MAX_CONCURRENT_READS = 10     # like the guest page: batches of 10 status reads


def setter_attribute(capability: str, command: str) -> str | None:
    if (capability, command) in SETTER_ATTRIBUTES:
        return SETTER_ATTRIBUTES[(capability, command)]
    m = re.fullmatch(r"set([A-Z]\w*)", command)
    return m.group(1)[0].lower() + m.group(1)[1:] if m else None


def _humanize(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", " ", name.split(".")[-1]).lower()


def format_value(value: Any, unit: str | None) -> str:
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    unit = UNIT_TEXT.get(unit or "", unit or "")
    if not unit:
        return str(value)
    return f"{value}{unit}" if unit in TIGHT_UNITS else f"{value} {unit}"


def _scalar(value: Any) -> bool:
    return isinstance(value, (str, int, float, bool)) and value != ""


@dataclass
class DeviceState:
    device: Device
    components: dict[str, Any] | None = None  # status["components"]; None = could not read
    online: bool | None = None                # from /health; None = unknown
    error: str | None = None

    @property
    def readable(self) -> bool:
        return self.components is not None and self.online is not False

    def value(self, capability: str, attribute: str, component: str = "main") -> tuple[Any, str | None]:
        """(value, unit) of one attribute; (None, None) when the device doesn't report it."""
        node = ((self.components or {}).get(component) or {}).get(capability) or {}
        attr = node.get(attribute) if isinstance(node, dict) else None
        if not isinstance(attr, dict):
            return None, None
        unit = attr.get("unit") or DEFAULT_UNITS.get((capability, attribute))
        return attr.get("value"), unit

    def number(self, capability: str, attribute: str, component: str = "main") -> float | None:
        value, _ = self.value(capability, attribute, component)
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            return float(value)
        try:
            return float(str(value))
        except (TypeError, ValueError):
            return None

    def _components(self) -> list[str]:
        used = [c.get("component") or "main" for c in self.device.commands]
        return [c for c in dict.fromkeys(["main", *used]) if c in (self.components or {})]

    def readings(self) -> list[tuple[str, str]]:
        """[(label, text)] for every known attribute the device reports, e.g. ("brightness", "70%")."""
        out: list[tuple[str, str]] = []
        controlled = {(c.get("component") or "main", c.get("capability")) for c in self.device.commands}
        for comp in self._components():
            caps = (self.components or {}).get(comp) or {}
            suffix = "" if comp == "main" else f" ({comp})"
            for (cap, attr), label in READINGS.items():
                value, unit = self.value(cap, attr, comp)
                if _scalar(value):
                    out.append((label + suffix, format_value(value, unit)))
            # capabilities the device is controlled with but that READINGS doesn't know
            for cap, attrs in caps.items():
                if (comp, cap) not in controlled or any(c == cap for c, _ in READINGS) or not isinstance(attrs, dict):
                    continue
                extra = [
                    (a, v) for a, v in attrs.items()
                    if isinstance(v, dict) and _scalar(v.get("value"))
                    and not a.startswith(("supported", "available"))
                ][:MAX_EXTRA_PER_CAPABILITY]
                for a, v in extra:
                    out.append((_humanize(a) + suffix, format_value(v["value"], v.get("unit"))))
        return out

    def line(self) -> str:
        """One prompt line: "- Desk Lamp (room: Lounge): power on, brightness 70%"."""
        room = f" (room: {self.device.room})" if self.device.room else ""
        head = f"- {self.device.name}{room}: "
        if self.online is False:
            return head + "OFFLINE, no current readings"
        if self.components is None:
            return head + f"status could not be read ({self.error or 'unknown error'})"
        parts = [f"{label} {text}" for label, text in self.readings()]
        return head + (", ".join(parts) if parts else "no readings reported")

    def as_dict(self) -> dict[str, Any]:
        return {
            "device_id": self.device.id,
            "device_name": self.device.name,
            "online": self.online,
            "readings": dict(self.readings()) if self.readable else {},
            **({"error": self.error} if self.error else {}),
        }


async def read_states(
    st: SmartThingsClient, devices: list[Device], token: str | None, *, health: bool = True
) -> list[DeviceState]:
    """Fetch /status (and /health) fresh for each device, at most MAX_CONCURRENT_READS at a time."""
    gate = asyncio.Semaphore(MAX_CONCURRENT_READS)

    async def one(device: Device) -> DeviceState:
        async with gate:
            if health:
                status, h = await asyncio.gather(st.get_status(device.id, token), st.get_health(device.id, token))
            else:
                status, h = await st.get_status(device.id, token), None
        state = DeviceState(device)
        if h is not None and h.ok and isinstance(h.response, dict) and h.response.get("state"):
            state.online = str(h.response["state"]).upper() != "OFFLINE"
        if status.ok and isinstance(status.response, dict) and isinstance(status.response.get("components"), dict):
            state.components = status.response["components"]
        else:
            state.error = status.error or "no status returned"
        return state

    return list(await asyncio.gather(*(one(d) for d in devices)))
