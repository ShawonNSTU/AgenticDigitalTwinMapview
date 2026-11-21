"""Stand-in for api.smartthings.com/v1 (devices, status, health, commands) that records every request, for testing
the SmartThings integration without an account. Run: python3 tools/smartthings_mock.py, then start the web app with
SMARTTHINGS_API=http://127.0.0.1:9010/v1 SMARTTHINGS_TOKEN=test-token. GET /_log lists the commands received.

The SmartThings Experience Zone's 12 real devices are here under their real deviceIds and labels
(docs/smartthings-zone-devices.md). POST /_set/{deviceId} {"capability": .., "attribute": .., "value": ..} changes a
device as the SmartThings app or a wall switch would (the twin must follow it on its own); POST /_health/{deviceId}
{"state": "OFFLINE"} takes it offline. GET /devices?deviceId=..&includeStatus=true&includeHealth=true answers in one
request, as the real API does with the 20170916 Accept version."""
import json
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

DEV = {
    "st-lock-1": {"label": "Front door lock 403", "caps": ["lock", "battery"], "state": {"lock": {"lock": {"value": "locked"}}, "battery": {"battery": {"value": 87}}}, "health": "ONLINE"},
    "st-ac-1": {"label": "Wall AC 403", "caps": ["switch", "thermostatCoolingSetpoint", "airConditionerMode", "temperatureMeasurement"],
                "state": {"switch": {"switch": {"value": "on"}}, "thermostatCoolingSetpoint": {"coolingSetpoint": {"value": 25}}, "temperatureMeasurement": {"temperature": {"value": 27.5}},
                          "airConditionerMode": {"airConditionerMode": {"value": "cool"}, "supportedAcModes": {"value": ["cool", "dry", "auto"]}}}, "health": "ONLINE"},
    "st-light-1": {"label": "Ceiling light 403", "caps": ["switch", "switchLevel"], "state": {"switch": {"switch": {"value": "off"}}, "switchLevel": {"level": {"value": 0}}}, "health": "ONLINE"},
}


def _bulb(label, on=True, level=60, ct=3000):
    return {"label": label, "caps": ["switch", "switchLevel", "colorTemperature", "colorControl"],
            "state": {"switch": {"switch": {"value": "on" if on else "off"}}, "switchLevel": {"level": {"value": level}},
                      "colorTemperature": {"colorTemperature": {"value": ct}}, "colorControl": {"hue": {"value": 0}, "saturation": {"value": 0}}}, "health": "ONLINE"}


def _switch(label, on=False):
    return {"label": label, "caps": ["switch"], "state": {"switch": {"switch": {"value": "on" if on else "off"}}}, "health": "ONLINE"}


def _shade(label, level=100):
    return {"label": label, "caps": ["windowShade", "windowShadeLevel"],
            "state": {"windowShade": {"windowShade": {"value": "open" if level == 100 else "closed" if level == 0 else "partially open"}}, "windowShadeLevel": {"shadeLevel": {"value": level}}}, "health": "ONLINE"}


# the SmartThings Experience Zone (room 401), as in the zone's account
ZONE = {
    "77233c09-6de7-4903-a137-ea7bf1d301ae": _shade("Aqara Roller Shade Controller", 100),
    "648ac2ca-a762-4fb1-91be-b8eba39b5c2c": _switch("Blinds Switch"),
    "0f477ef7-8574-4be9-9bb3-f72ed5f719e6": _bulb("Desk Lamp", True, 50),
    "aaa3da5b-bbda-4b4e-90fc-ac11f0c6071c": _switch("Left Window Light", True),
    "ce885b72-4a0a-47c3-9549-f8e384ff9fd7": _bulb("Light 1", True, 60),
    "d82bda78-4f9b-4069-982e-b8d8af4dccd0": _bulb("Light 2", True, 40),
    "c17a9a75-5990-4638-bea8-64c9b96b2890": _bulb("Light 3", False, 30),
    "fe2dc605-3fd0-49eb-879e-9e00f252f5d5": _bulb("Light 4", False, 30),
    "e39a788e-d559-429b-a18c-298382429b2d": _switch("Right Window Light", True),
    "9bd3918b-26ee-4fbb-82cc-99c6a61da528": _switch("TV Lamp", True),
    "434402bd-cea2-463d-95e3-f9a1735e6ce8": _bulb("Light 5", True, 80),
    "facda6c1-5784-4819-bd73-02dc7f6925ea": _switch("side lamp"),
}
DEV.update(ZONE)
# in the same account but not in the zone room: the twin must never place or link it there
DEV["09611dc5-d2d0-4d4b-a3a1-ce6bc9ab1c4d"] = _shade("Aqara Roller Shade Controller of dining", 0)
# rooms and categories as the real account reports them (GET /devices gives roomId and components[].categories)
ROOMS = {"room-401": "Room 401", "room-403": "Training Room 403"}
META = {
    "st-lock-1": ("room-403", "SmartLock"), "st-ac-1": ("room-403", "AirConditioner"), "st-light-1": ("room-403", "Light"),
    "st-z-hue": ("room-401", "Light"), "st-z-speaker": ("room-401", "Speaker"), "st-hub": ("room-401", "Hub"),
}
DEV.update({
    # in the zone's account but not among the twin's names: it takes over a simulated light or is added
    "st-z-hue": {"label": "Hue Go", "caps": ["switch", "switchLevel", "colorControl"], "state": {"switch": {"switch": {"value": "on"}}, "switchLevel": {"level": {"value": 40}}}, "health": "ONLINE"},
    "st-z-speaker": {"label": "Galaxy Home Mini", "caps": ["audioVolume", "mediaPlayback"], "state": {"audioVolume": {"volume": {"value": 20}}}, "health": "ONLINE"},
    "st-hub": {"label": "SmartThings Hub", "caps": ["bridge"], "state": {}, "health": "ONLINE"},
})
LOG = []
META["09611dc5-d2d0-4d4b-a3a1-ce6bc9ab1c4d"] = ("room-401", "Blind")
for _k, _v in ZONE.items():
    META[_k] = ("room-401", "Blind" if "windowShade" in _v["caps"] else "Light" if "Light" in _v["label"] or "Lamp" in _v["label"] or "lamp" in _v["label"] else "Switch")


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _set(dev, cap, attr, value):
    """Set an attribute with the time it changed (the API reports a timestamp per attribute)."""
    DEV[dev]["state"].setdefault(cap, {})[attr] = {"value": value, "timestamp": _now()}


def _item(k, v):
    room, cat = META.get(k, ("", ""))
    return {"deviceId": k, "label": v["label"], "roomId": room, "locationId": "loc-1",
            "components": [{"id": "main", "capabilities": [{"id": c} for c in v["caps"]], "categories": [{"name": cat, "categoryType": "manufacturer"}]}]}
FAIL = {"next": False}
# commands of the standard capabilities the zone uses: name -> validator of the positional arguments
SPEC = {
    "switch": {"on": lambda a: a == [], "off": lambda a: a == []},
    "switchLevel": {"setLevel": lambda a: len(a) in (1, 2) and isinstance(a[0], int) and 0 <= a[0] <= 100},
    "colorTemperature": {"setColorTemperature": lambda a: len(a) == 1 and isinstance(a[0], int) and 1 <= a[0] <= 30000},
    "colorControl": {"setColor": lambda a: len(a) == 1 and isinstance(a[0], dict) and all(isinstance(a[0].get(k), (int, float)) and 0 <= a[0][k] <= 100 for k in ("hue", "saturation")),
                     "setHue": lambda a: len(a) == 1 and 0 <= a[0] <= 100, "setSaturation": lambda a: len(a) == 1 and 0 <= a[0] <= 100},
    "windowShade": {"open": lambda a: a == [], "close": lambda a: a == [], "pause": lambda a: a == []},
    "windowShadeLevel": {"setShadeLevel": lambda a: len(a) == 1 and isinstance(a[0], int) and 0 <= a[0] <= 100},
}
# the real devices' own limits (docs/smartthings-zone-devices.md)
LIMITS = {("switchLevel", "setLevel"): (1, 100), ("colorTemperature", "setColorTemperature"): (2200, 6500)}


def _invalid(dev, body):
    """Why the real API would refuse this command body (None if it would accept it)."""
    if not isinstance(body, dict) or not isinstance(body.get("commands"), list) or not body["commands"]:
        return "The request body is malformed: expected {\"commands\": [...]}"
    for c in body["commands"]:
        if set(c) - {"component", "capability", "command", "arguments"} or not all(k in c for k in ("capability", "command")):
            return f"malformed command {c}"
        if c.get("component", "main") != "main":
            return f"no component {c.get('component')}"
        cap, cmd, args = c["capability"], c["command"], c.get("arguments", [])
        if dev in ZONE and cap not in DEV[dev]["caps"]:
            return f"{DEV[dev]['label']} has no capability {cap}"
        if dev in ZONE:
            if cmd not in SPEC.get(cap, {}):
                return f"{cap} has no command {cmd}"
            if not isinstance(args, list) or not SPEC[cap][cmd](args):
                return f"{cap}.{cmd}: invalid arguments {args}"
            lim = LIMITS.get((cap, cmd))
            if lim and not lim[0] <= args[0] <= lim[1]:
                return f"{cap}.{cmd}: {args[0]} is outside {lim[0]}-{lim[1]}"
    return None
STATS = {"list": 0, "status": 0}


class H(BaseHTTPRequestHandler):
    def _send(self, code, body):
        b = json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/_log":
            return self._send(200, LOG)
        if self.path == "/_stats":
            return self._send(200, STATS)
        if self.headers.get("Authorization") != "Bearer test-token":
            return self._send(401, {"error": {"message": "Unauthorized"}})
        u = urlsplit(self.path)
        p = u.path.removeprefix("/v1")
        q = parse_qs(u.query)
        if p == "/devices":
            ids = q.get("deviceId") or list(DEV)
            batch = q.get("includeStatus") == ["true"] and "20170916" in (self.headers.get("Accept") or "")
            items = []
            for k in ids:
                if k not in DEV:
                    continue
                it = _item(k, DEV[k])
                if batch:
                    it["components"][0]["status"] = DEV[k]["state"]
                    it["healthState"] = {"state": DEV[k]["health"]}
                items.append(it)
            STATS["list"] += 1
            return self._send(200, {"items": items, "_links": {}})
        if p == "/locations":
            return self._send(200, {"items": [{"locationId": "loc-1", "name": "Samsung R&D"}]})
        if p == "/locations/loc-1/rooms":
            return self._send(200, {"items": [{"roomId": k, "name": v, "locationId": "loc-1"} for k, v in ROOMS.items()]})
        parts = p.strip("/").split("/")
        if len(parts) == 2 and parts[1] in DEV:
            v = DEV[parts[1]]
            return self._send(200, _item(parts[1], v))
        if len(parts) == 3 and parts[2] == "status":
            STATS["status"] += 1
            return self._send(200, {"components": {"main": DEV[parts[1]]["state"]}})
        if len(parts) == 3 and parts[2] == "health":
            return self._send(200, {"deviceId": parts[1], "state": DEV[parts[1]]["health"]})
        self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/_fail":
            FAIL["next"] = True
            return self._send(200, {})
        if self.path.startswith("/_set/"):
            dev = self.path.split("/")[2]
            _set(dev, body["capability"], body["attribute"], body["value"])
            return self._send(200, DEV[dev]["state"])
        if self.path.startswith("/_health/"):
            DEV[self.path.split("/")[2]]["health"] = body["state"]
            return self._send(200, {})
        if self.headers.get("Authorization") != "Bearer test-token":
            return self._send(401, {"error": {"message": "Unauthorized"}})
        dev = self.path.removeprefix("/v1").strip("/").split("/")[1]
        if dev not in DEV:
            return self._send(404, {"error": {"code": "NotFoundError", "message": f"device {dev} not found"}})
        bad = _invalid(dev, body)
        LOG.append({"device": dev, "body": body, "refused": bad})
        if bad:
            return self._send(422, {"error": {"code": "ConstraintViolationError", "message": bad}})
        if DEV[dev]["health"] != "ONLINE":
            # the API takes the command but the device can't run it
            return self._send(200, {"results": [{"id": "x", "status": "FAILED"}]})
        if FAIL["next"]:
            FAIL["next"] = False
            return self._send(422, {"error": {"code": "ConstraintViolationError", "message": "device did not respond"}})
        for c in body["commands"]:
            cap, cmd, args = c["capability"], c["command"], c.get("arguments", [])
            if cap == "lock":
                _set(dev, "lock", "lock", "unlocked" if cmd == "unlock" else "locked")
            if cap == "switch":
                _set(dev, "switch", "switch", cmd)
            if cap == "switchLevel":
                _set(dev, "switchLevel", "level", args[0])
            if cap == "colorTemperature":
                _set(dev, "colorTemperature", "colorTemperature", args[0])
            if cap == "colorControl":
                _set(dev, "colorControl", "hue", args[0]["hue"]); _set(dev, "colorControl", "saturation", args[0]["saturation"])
            if cap == "thermostatCoolingSetpoint":
                _set(dev, "thermostatCoolingSetpoint", "coolingSetpoint", args[0])
            if cap == "windowShadeLevel":
                _set(dev, "windowShadeLevel", "shadeLevel", args[0])
                _set(dev, "windowShade", "windowShade", "open" if args[0] == 100 else "closed" if args[0] == 0 else "partially open")
            if cap == "windowShade":
                _set(dev, "windowShade", "windowShade", "open" if cmd == "open" else "closed")
                _set(dev, "windowShadeLevel", "shadeLevel", 100 if cmd == "open" else 0)
            if cap == "airConditionerMode":
                _set(dev, "airConditionerMode", "airConditionerMode", args[0])
        self._send(200, {"results": [{"id": "x", "status": "ACCEPTED"}]})


ThreadingHTTPServer(("127.0.0.1", 9010), H).serve_forever()
