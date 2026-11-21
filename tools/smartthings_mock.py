"""Stand-in for api.smartthings.com/v1 (devices, status, health, commands) that records every request, for testing
the SmartThings integration without an account. Run: python3 tools/smartthings_mock.py, then start the web app with
SMARTTHINGS_API=http://127.0.0.1:9010/v1 SMARTTHINGS_TOKEN=test-token. GET /_log lists the commands received."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEV = {
    "st-lock-1": {"label": "Front door lock 403", "caps": ["lock", "battery"], "state": {"lock": {"lock": {"value": "locked"}}, "battery": {"battery": {"value": 87}}}, "health": "ONLINE"},
    "st-ac-1": {"label": "Wall AC 403", "caps": ["switch", "thermostatCoolingSetpoint", "airConditionerMode", "temperatureMeasurement"],
                "state": {"switch": {"switch": {"value": "on"}}, "thermostatCoolingSetpoint": {"coolingSetpoint": {"value": 25}}, "temperatureMeasurement": {"temperature": {"value": 27.5}},
                          "airConditionerMode": {"airConditionerMode": {"value": "cool"}, "supportedAcModes": {"value": ["cool", "dry", "auto"]}}}, "health": "ONLINE"},
    "st-light-1": {"label": "Ceiling light 403", "caps": ["switch", "switchLevel"], "state": {"switch": {"switch": {"value": "off"}}, "switchLevel": {"level": {"value": 0}}}, "health": "ONLINE"},
    # a few of the SmartThings Experience Zone's devices, under the names its SmartThings app uses
    "st-z-light1": {"label": "Light 1", "caps": ["switch", "switchLevel"], "state": {"switch": {"switch": {"value": "on"}}, "switchLevel": {"level": {"value": 60}}}, "health": "ONLINE"},
    "st-z-shade": {"label": "aqara roller shade control", "caps": ["windowShade", "windowShadeLevel"], "state": {"windowShade": {"windowShade": {"value": "open"}}, "windowShadeLevel": {"shadeLevel": {"value": 100}}}, "health": "ONLINE"},
    "st-z-switch": {"label": "blinds switch", "caps": ["switch"], "state": {"switch": {"switch": {"value": "off"}}}, "health": "ONLINE"},
}
# rooms and categories as the real account reports them (GET /devices gives roomId and components[].categories)
ROOMS = {"room-401": "Room 401", "room-403": "Training Room 403"}
META = {
    "st-lock-1": ("room-403", "SmartLock"), "st-ac-1": ("room-403", "AirConditioner"), "st-light-1": ("room-403", "Light"),
    "st-z-light1": ("room-401", "Light"), "st-z-shade": ("room-401", "Blind"), "st-z-switch": ("room-401", "Switch"),
    "st-z-hue": ("room-401", "Light"), "st-z-speaker": ("room-401", "Speaker"), "st-hub": ("room-401", "Hub"),
}
DEV.update({
    # in the zone's account but not among the twin's names: it takes over a simulated light or is added
    "st-z-hue": {"label": "Hue Go", "caps": ["switch", "switchLevel", "colorControl"], "state": {"switch": {"switch": {"value": "on"}}, "switchLevel": {"level": {"value": 40}}}, "health": "ONLINE"},
    "st-z-speaker": {"label": "Galaxy Home Mini", "caps": ["audioVolume", "mediaPlayback"], "state": {"audioVolume": {"volume": {"value": 20}}}, "health": "ONLINE"},
    "st-hub": {"label": "SmartThings Hub", "caps": ["bridge"], "state": {}, "health": "ONLINE"},
})
LOG = []


def _item(k, v):
    room, cat = META.get(k, ("", ""))
    return {"deviceId": k, "label": v["label"], "roomId": room, "locationId": "loc-1",
            "components": [{"id": "main", "capabilities": [{"id": c} for c in v["caps"]], "categories": [{"name": cat, "categoryType": "manufacturer"}]}]}
FAIL = {"next": False}


class H(BaseHTTPRequestHandler):
    def _send(self, code, body):
        b = json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/_log":
            return self._send(200, LOG)
        if self.headers.get("Authorization") != "Bearer test-token":
            return self._send(401, {"error": {"message": "Unauthorized"}})
        p = self.path.split("?")[0].removeprefix("/v1")
        if p == "/devices":
            return self._send(200, {"items": [_item(k, v) for k, v in DEV.items()], "_links": {}})
        if p == "/locations":
            return self._send(200, {"items": [{"locationId": "loc-1", "name": "Samsung R&D"}]})
        if p == "/locations/loc-1/rooms":
            return self._send(200, {"items": [{"roomId": k, "name": v, "locationId": "loc-1"} for k, v in ROOMS.items()]})
        parts = p.strip("/").split("/")
        if len(parts) == 2 and parts[1] in DEV:
            v = DEV[parts[1]]
            return self._send(200, _item(parts[1], v))
        if len(parts) == 3 and parts[2] == "status":
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
        if self.path.startswith("/_health/"):
            DEV[self.path.split("/")[2]]["health"] = body["state"]
            return self._send(200, {})
        if self.headers.get("Authorization") != "Bearer test-token":
            return self._send(401, {"error": {"message": "Unauthorized"}})
        dev = self.path.removeprefix("/v1").strip("/").split("/")[1]
        LOG.append({"device": dev, "body": body})
        if FAIL["next"]:
            FAIL["next"] = False
            return self._send(422, {"error": {"code": "ConstraintViolationError", "message": "device did not respond"}})
        for c in body["commands"]:
            s = DEV[dev]["state"]
            if c["capability"] == "lock":
                s["lock"]["lock"]["value"] = "unlocked" if c["command"] == "unlock" else "locked"
            if c["capability"] == "switch":
                s["switch"]["switch"]["value"] = c["command"]
            if c["capability"] == "switchLevel":
                s["switchLevel"]["level"]["value"] = c["arguments"][0]
            if c["capability"] == "thermostatCoolingSetpoint":
                s["thermostatCoolingSetpoint"]["coolingSetpoint"]["value"] = c["arguments"][0]
            if c["capability"] == "windowShadeLevel":
                s["windowShadeLevel"]["shadeLevel"]["value"] = c["arguments"][0]
            if c["capability"] == "windowShade":
                s["windowShade"]["windowShade"]["value"] = "open" if c["command"] == "open" else "closed"
                s["windowShadeLevel"]["shadeLevel"]["value"] = 100 if c["command"] == "open" else 0
            if c["capability"] == "airConditionerMode":
                s["airConditionerMode"]["airConditionerMode"]["value"] = c["arguments"][0]
        self._send(200, {"results": [{"id": "x", "status": "ACCEPTED"}]})


ThreadingHTTPServer(("127.0.0.1", 9010), H).serve_forever()
