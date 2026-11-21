#!/usr/bin/env python3
"""Check the SmartThings Experience Zone's 12 real devices against the SmartThings API (standard library only).

Read-only by default: for every device in web/lib/integrations/zone-devices.ts it checks that the deviceId exists
for the token, that its label and capabilities are what the twin expects, and reads its status and health.

With --control it also runs every command each device supports (switch on/off, level, colour temperature, colour,
shade open/close/level), waits until the device reports the new state, and puts the device back the way it was.
Lights and shades in the room WILL change for a few seconds each.

  python3 tools/smartthings_zone_check.py                      # token from SMARTTHINGS_TOKEN or web/.env
  python3 tools/smartthings_zone_check.py --control
  python3 tools/smartthings_zone_check.py --only "Light 1" --control
  python3 tools/smartthings_zone_check.py --api http://127.0.0.1:9010/v1 --token test-token --control   # the mock
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTRY = os.path.join(ROOT, "web", "lib", "integrations", "zone-devices.ts")


def registry():
    src = open(REGISTRY, encoding="utf-8").read()
    caps = {m.group(1): re.findall(r"'([A-Za-z]+)'", m.group(2)) for m in re.finditer(r"const (\w+) = \[([^\]]*)\];", src)}
    out = []
    for m in re.finditer(r"\{ label: '([^']+)', stId: '([0-9a-f-]+)', type: '(\w+)', capabilities: (\w+) \}", src):
        out.append({"label": m.group(1), "stId": m.group(2), "type": m.group(3), "caps": caps[m.group(4)]})
    if len(out) != 12:
        sys.exit(f"expected 12 devices in {REGISTRY}, found {len(out)}")
    return out


def token_from_env():
    t = os.environ.get("SMARTTHINGS_TOKEN", "")
    env = os.path.join(ROOT, "web", ".env")
    if not t and os.path.exists(env):
        for line in open(env, encoding="utf-8"):
            if line.strip().startswith("SMARTTHINGS_TOKEN="):
                t = line.split("=", 1)[1].strip().strip('"').strip("'")
    return t


class Api:
    def __init__(self, base, token):
        self.base, self.token = base.rstrip("/"), token

    def req(self, method, path, body=None, tries=3):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method,
                                   headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(r, timeout=15) as resp:
                txt = resp.read().decode()
                return resp.status, (json.loads(txt) if txt else {})
        except urllib.error.HTTPError as e:
            txt = e.read().decode(errors="replace")
            if e.code == 429 and tries > 1:
                time.sleep(float(e.headers.get("Retry-After") or 5))
                return self.req(method, path, body, tries - 1)
            try:
                return e.code, json.loads(txt)
            except ValueError:
                return e.code, {"raw": txt}

    def status(self, sid):
        code, b = self.req("GET", f"/devices/{sid}/status")
        if code != 200:
            raise RuntimeError(f"status HTTP {code}: {err(b)}")
        return b.get("components", {}).get("main", {})

    def command(self, sid, cap, cmd, args=None):
        code, b = self.req("POST", f"/devices/{sid}/commands", {"commands": [{"component": "main", "capability": cap, "command": cmd, "arguments": args or []}]})
        if code != 200:
            raise RuntimeError(f"{cap}.{cmd}{args or ''} refused: HTTP {code} {err(b)}")
        bad = [r.get("status") for r in b.get("results", []) if str(r.get("status")).upper() in ("FAILED", "REJECTED")]
        if bad:
            raise RuntimeError(f"{cap}.{cmd}{args or ''}: device reported {bad}")


def err(b):
    return (b.get("error") or {}).get("message") or b.get("message") or b.get("raw", "")[:200] or json.dumps(b)[:200]


def val(st, cap, attr):
    return ((st.get(cap) or {}).get(attr) or {}).get("value")


def wait_for(api, sid, check, timeout):
    """Poll the device's status until check(status) holds; returns the seconds it took, or raises."""
    t0, last = time.time(), None
    while time.time() - t0 < timeout:
        last = api.status(sid)
        if check(last):
            return time.time() - t0
        time.sleep(0.5)
    raise RuntimeError(f"device did not report the change within {timeout:.0f} s (last status: {json.dumps(last)[:300]})")


class Report:
    def __init__(self):
        self.rows = []

    def add(self, dev, what, ok, note=""):
        self.rows.append((dev, what, ok, note))
        print(f"  {'PASS' if ok else 'FAIL'}  {what}{('  ' + note) if note else ''}", flush=True)

    def failed(self):
        return [r for r in self.rows if not r[2]]


def step(rep, dev, what, fn):
    try:
        note = fn()
        rep.add(dev, what, True, note or "")
        return True
    except Exception as e:  # noqa: BLE001 - every failure is reported, the run goes on
        rep.add(dev, what, False, str(e))
        return False


def read_checks(api, d, rep):
    name = d["label"]
    code, info = api.req("GET", f"/devices/{d['stId']}")
    if code != 200:
        rep.add(name, "device exists for this token", False, f"HTTP {code}: {err(info)}")
        return None
    rep.add(name, "device exists for this token", True)
    label = info.get("label") or info.get("name")
    rep.add(name, "label matches", label == name, f"SmartThings label is {label!r}" if label != name else "")
    main = next((c for c in info.get("components", []) if c.get("id") == "main"), {})
    have = {c["id"] for c in main.get("capabilities", [])}
    missing = [c for c in d["caps"] if c not in have]
    rep.add(name, "capabilities on main", not missing, f"missing {missing} (has {sorted(have)})" if missing else f"{', '.join(d['caps'])}")
    code, h = api.req("GET", f"/devices/{d['stId']}/health")
    online = h.get("state") == "ONLINE" if code == 200 else None
    rep.add(name, "online", bool(online), f"health: {h.get('state') if code == 200 else 'HTTP %s' % code}")
    try:
        st = api.status(d["stId"])
        summary = {c: {a: v.get("value") for a, v in st.get(c, {}).items() if a in ("switch", "level", "colorTemperature", "hue", "saturation", "windowShade", "shadeLevel")} for c in d["caps"]}
        rep.add(name, "status readable", True, json.dumps(summary))
    except Exception as e:  # noqa: BLE001
        rep.add(name, "status readable", False, str(e))
        return None
    return st


def control_checks(api, d, st, rep, by_label, timeout):
    name, sid, caps = d["label"], d["stId"], d["caps"]
    sw0 = val(st, "switch", "switch")
    lv0 = val(st, "switchLevel", "level")
    ct0 = val(st, "colorTemperature", "colorTemperature")
    hue0, sat0 = val(st, "colorControl", "hue"), val(st, "colorControl", "saturation")
    shade0 = val(st, "windowShadeLevel", "shadeLevel")
    restore = []
    try:
        if "switch" in caps:
            other = "off" if sw0 == "on" else "on"
            step(rep, name, f"switch.{other}", lambda: (api.command(sid, "switch", other), f"reported in {wait_for(api, sid, lambda s: val(s, 'switch', 'switch') == other, timeout):.1f} s")[1])
            step(rep, name, f"switch.{'on' if other == 'off' else 'off'}", lambda: (api.command(sid, "switch", "on" if other == "off" else "off"), f"reported in {wait_for(api, sid, lambda s: val(s, 'switch', 'switch') != other, timeout):.1f} s")[1])
        if "switchLevel" in caps:
            restore.append(("switch", sw0))
            target = 35 if (lv0 or 0) > 50 else 75
            if lv0 is not None:
                restore.insert(0, ("level", lv0))
            step(rep, name, f"switchLevel.setLevel({target})", lambda: (api.command(sid, "switchLevel", "setLevel", [target]), f"reported in {wait_for(api, sid, lambda s: abs((val(s, 'switchLevel', 'level') or -99) - target) <= 1, timeout):.1f} s")[1])
            step(rep, name, "switchLevel.setLevel(1) (lowest the device takes)", lambda: (api.command(sid, "switchLevel", "setLevel", [1]), f"reported in {wait_for(api, sid, lambda s: (val(s, 'switchLevel', 'level') or 99) <= 2, timeout):.1f} s")[1])
        white_last = True
        if "colorControl" in caps and "colorTemperature" in caps:
            ts = lambda cap, attr: ((st.get(cap) or {}).get(attr) or {}).get("timestamp") or ""
            white_last = ts("colorTemperature", "colorTemperature") >= max(ts("colorControl", "hue"), ts("colorControl", "saturation"))
        if "colorControl" in caps:
            step(rep, name, "colorControl.setColor({hue: 75, saturation: 100}) (purple)", lambda: (api.command(sid, "colorControl", "setColor", [{"hue": 75, "saturation": 100}]),
                 f"reported in {wait_for(api, sid, lambda s: abs((val(s, 'colorControl', 'hue') or -99) - 75) <= 2 and (val(s, 'colorControl', 'saturation') or 0) >= 95, timeout):.1f} s")[1])
            if hue0 is not None and sat0 is not None and not white_last:
                restore.insert(0, ("color", (hue0, sat0)))
        if "colorTemperature" in caps:
            for k in (2200, 6500, 4000):
                step(rep, name, f"colorTemperature.setColorTemperature({k})", lambda k=k: (api.command(sid, "colorTemperature", "setColorTemperature", [k]),
                     f"reported in {wait_for(api, sid, lambda s: abs((val(s, 'colorTemperature', 'colorTemperature') or 0) - k) <= 150, timeout):.1f} s")[1])
            if ct0 is not None and white_last:
                restore.insert(0, ("ct", ct0))
        if "windowShadeLevel" in caps:
            motor = by_label.get("Blinds Switch") if name == "Aqara Roller Shade Controller" else None
            if motor:
                ms = val(api.status(motor["stId"]), "switch", "switch")
                if ms != "on":
                    step(rep, name, "Blinds Switch on (powers this shade's motor)", lambda: (api.command(motor["stId"], "switch", "on"), f"reported in {wait_for(api, motor['stId'], lambda s: val(s, 'switch', 'switch') == 'on', timeout):.1f} s")[1])
                    restore.append(("motor", (motor["stId"], ms)))
            target = 30 if (shade0 or 0) > 50 else 70
            if shade0 is not None:
                restore.insert(0, ("shade", shade0))
            shade_wait = max(timeout, 60)
            step(rep, name, f"windowShadeLevel.setShadeLevel({target})", lambda: (api.command(sid, "windowShadeLevel", "setShadeLevel", [target]),
                 f"reported in {wait_for(api, sid, lambda s: abs((val(s, 'windowShadeLevel', 'shadeLevel') or -99) - target) <= 3, shade_wait):.1f} s")[1])
            step(rep, name, "windowShade.open", lambda: (api.command(sid, "windowShade", "open"),
                 f"reported in {wait_for(api, sid, lambda s: (val(s, 'windowShadeLevel', 'shadeLevel') or 0) >= 97 or val(s, 'windowShade', 'windowShade') == 'open', shade_wait):.1f} s")[1])
            step(rep, name, "windowShade.close", lambda: (api.command(sid, "windowShade", "close"),
                 f"reported in {wait_for(api, sid, lambda s: (val(s, 'windowShadeLevel', 'shadeLevel') or 100) <= 3 or val(s, 'windowShade', 'windowShade') == 'closed', shade_wait):.1f} s")[1])
    finally:
        # put the device back as it was (best effort; reported, never raised)
        for kind, v in restore:
            try:
                if kind == "level":
                    api.command(sid, "switchLevel", "setLevel", [max(1, int(v))])
                elif kind == "ct":
                    api.command(sid, "colorTemperature", "setColorTemperature", [int(v)])
                elif kind == "color":
                    api.command(sid, "colorControl", "setColor", [{"hue": v[0], "saturation": v[1]}])
                elif kind == "shade":
                    api.command(sid, "windowShadeLevel", "setShadeLevel", [int(v)])
                elif kind == "switch" and v in ("on", "off"):
                    api.command(sid, "switch", v)
                elif kind == "motor" and v[1] in ("on", "off"):
                    api.command(v[0], "switch", v[1])
            except Exception as e:  # noqa: BLE001
                rep.add(name, f"restore {kind}", False, str(e))
        if restore:
            print(f"  ....  restored {', '.join(k for k, _ in restore)}", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--token", default="")
    ap.add_argument("--api", default=os.environ.get("SMARTTHINGS_API", "https://api.smartthings.com/v1"))
    ap.add_argument("--control", action="store_true", help="run every command (devices change for a few seconds, then are restored)")
    ap.add_argument("--only", action="append", default=[], help="label of a device to check (repeatable)")
    ap.add_argument("--timeout", type=float, default=15, help="seconds to wait for a device to report a change (shades: at least 60)")
    a = ap.parse_args()
    token = a.token or token_from_env()
    if not token:
        sys.exit("No token: pass --token, set SMARTTHINGS_TOKEN or put SMARTTHINGS_TOKEN=... in web/.env")
    api = Api(a.api, token)
    code, b = api.req("GET", "/locations")
    if code == 401:
        sys.exit(f"The token was refused (HTTP 401: {err(b)}). Check it was copied exactly; a personal access token looks like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.")
    devs = registry()
    by_label = {d["label"]: d for d in devs}
    if a.only:
        devs = [d for d in devs if d["label"] in a.only]
    rep = Report()
    for d in devs:
        print(f"\n{d['label']}  ({d['stId']})", flush=True)
        st = read_checks(api, d, rep)
        if a.control and st is not None:
            control_checks(api, d, st, rep, by_label, a.timeout)
    bad = rep.failed()
    print(f"\n{len(rep.rows) - len(bad)} passed, {len(bad)} failed")
    for dev, what, _, note in bad:
        print(f"  FAIL  {dev}: {what}  {note}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
