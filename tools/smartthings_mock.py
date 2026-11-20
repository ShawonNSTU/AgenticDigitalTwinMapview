"""Stand-in for api.smartthings.com/v1 (devices, status, health, commands) that records every request, for testing
the SmartThings integration without an account. Run: python3 tools/smartthings_mock.py, then start the web app with
SMARTTHINGS_API=http://127.0.0.1:9010/v1 SMARTTHINGS_TOKEN=test-token. GET /_log lists the commands received."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEV = {
    "st-lock-1": {"label": "Front door lock 403", "caps": ["lock", "battery"], "state": {"lock": {"lock": {"value": "locked"}}, "battery": {"battery": {"value": 87}}}, "health": "ONLINE"},
    "st-light-1": {"label": "Ceiling light 403", "caps": ["switch", "switchLevel"], "state": {"switch": {"switch": {"value": "off"}}, "switchLevel": {"level": {"value": 0}}}, "health": "ONLINE"},
}
LOG = []
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
            return self._send(200, {"items": [{"deviceId": k, "label": v["label"], "components": [{"id": "main", "capabilities": [{"id": c} for c in v["caps"]]}]} for k, v in DEV.items()], "_links": {}})
        parts = p.strip("/").split("/")
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
        self._send(200, {"results": [{"id": "x", "status": "ACCEPTED"}]})


ThreadingHTTPServer(("127.0.0.1", 9010), H).serve_forever()
