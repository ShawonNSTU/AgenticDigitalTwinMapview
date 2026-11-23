"""Skill: the hotel experience services of the twin, for staff and guests.

  comfort      how comfortable a room is (score, temperature vs target, air, light, noise) and what would improve it;
               "make it comfortable" applies that advice on the room's devices
  energy       watts now, kWh / cost / CO2 today, the energy the presence-aware automation avoided, biggest loads
  journey      a guest's arrival: on my way (ETA), prepare the room now, I'm heading out (eco), preferences;
               staff also see every expected guest, set an ETA and check guests out (eco + housekeeping)
  predictions  staff: which devices will fail soon, when, why and how sure
  dispatch     staff: send the right technician to a device; the 3D view draws the route from the lift lobby

One structured model call picks the action and its target from enums built from live twin data; the twin validates
and acts (a guest only ever reaches their own room and stay). Replies are written from the twin's numbers."""
from __future__ import annotations

from typing import Any

from app.core.context import TurnContext
from app.core.skill import Skill, SkillResult, register
from app.integrations.twin import TwinClient
from app.skills._staff import enum_schema, need_op, one_of

STAFF_ACTIONS = ["climate_vision", "comfort_status", "comfort_apply", "energy", "journeys", "eta", "prepare", "checkout", "predictions", "dispatch"]
GUEST_ACTIONS = ["climate_vision", "comfort_status", "comfort_apply", "energy", "journey_status", "on_my_way", "prepare", "away", "prefs"]

SYSTEM = """You are {bot}, the hotel's assistant. Pick what the user wants from the hotel's experience services.

Actions:
{actions}

{targets}
Rules: pick exactly one action. "minutes" only for an ETA ("in 20 minutes", "half an hour" = 30), else 0.
"temp" (°C), "scene" (warm|bright|calm|off) and "curtain" (0-100 % open) only for preferences, else 0 / "" / -1.
Reply with JSON only."""

ACTION_HELP = {
    "climate_vision": "show / visualise / see the air in 3D: heat map, airflow, how the AC cools the room, where the cold air goes, dust or smoke spreading, the purifier cleaning the air (Climate Vision)",
    "comfort_status": "how comfortable a room is / is it too warm / air quality / why it feels stuffy (no change)",
    "comfort_apply": "make a room comfortable / fix the comfort / optimise the room (changes devices)",
    "energy": "power, energy, kWh, electricity cost, carbon, savings, what uses the most power",
    "journeys": "which guests are arriving / expected / which rooms are being prepared / housekeeping",
    "journey_status": "is my room ready / status of my arrival",
    "eta": "a guest will arrive in N minutes (sets their ETA so the room is prepared in time)",
    "on_my_way": "I'm on my way / I'll be there in N minutes",
    "prepare": "prepare / pre-cool / get the room ready now",
    "away": "I'm heading out / going out for a while (room to eco)",
    "prefs": "my preferred temperature, light scene or curtain for arrival",
    "checkout": "check a guest out (room to eco, housekeeping)",
    "predictions": "what will fail next / predicted failures / predictive maintenance",
    "dispatch": "send / dispatch a technician to a device, route me to the fault",
}


@register
class ExperienceSkill(Skill):
    name = "experience"
    progress_text = "Checking the room"
    description = "Climate Vision (the room's heat, airflow and dust shown live in 3D), room comfort, energy and savings, guest arrival / check-out, predicted failures, technician dispatch."
    examples = ["make the room comfortable", "I'll be there in 20 minutes", "what will fail next?"]
    capability = "tell you how comfortable a room is, its energy use, prepare a room for arrival, and predict failures"

    def __init__(self, llm, settings, twin: TwinClient | None = None):
        super().__init__(llm, settings)
        self.twin = twin or TwinClient(settings)

    def is_available(self, ctx: TurnContext) -> bool:
        return bool(ctx.extras.get("role"))   # needs the twin's session (web app); not the standalone device agent

    async def run(self, ctx: TurnContext, request: str) -> SkillResult:
        staff = ctx.is_staff
        actions = STAFF_ACTIONS if staff else GUEST_ACTIONS
        rooms: list[dict[str, Any]] = []
        guests: list[dict[str, Any]] = []
        devices: list[str] = []
        targets = ""
        if staff:
            c = await need_op(self.twin, ctx, "comfort")
            rooms = (c.data or {}).get("rooms", []) if c.ok else []
            j = await need_op(self.twin, ctx, "journey")
            guests = (j.data or {}).get("journeys", []) if j.ok else []
            p = await need_op(self.twin, ctx, "predictions")
            preds = (p.data or {}).get("predictions", []) if p.ok else []
            a = await need_op(self.twin, ctx, "alerts")
            alerts = (a.data or {}).get("alerts", []) if a.ok else []
            devices = list(dict.fromkeys([x["device_id"] for x in preds] + [x["device_id"] for x in alerts]))
            targets = ("Rooms (id | name): " + "; ".join(f"{r['room']} | {r['name']}" for r in rooms[:40]) + "\n"
                       + "Guests (token | name | room | state): " + ("; ".join(f"{g['token']} | {g['guest'] or 'unnamed'} | {g['room']} | {g['state']}" for g in guests[:20]) or "none") + "\n"
                       + "Devices with alerts or predicted failures: " + (", ".join(devices) or "none") + "\n")
        props: dict[str, Any] = {"action": {"type": "string", "enum": actions}, "minutes": {"type": "number"},
                                 "temp": {"type": "number"}, "scene": {"type": "string", "enum": ["", "warm", "bright", "calm", "off"]}, "curtain": {"type": "number"}}
        if staff:
            props["room"] = one_of([r["room"] for r in rooms])
            props["guest"] = one_of([g["token"] for g in guests])
            props["device_id"] = one_of(devices)
        out = await self.llm.complete_json(
            system=SYSTEM.format(bot=self.settings.bot_name, actions="\n".join(f"- {k}: {ACTION_HELP[k]}" for k in actions), targets=targets),
            user=f"Request: {request}", schema=enum_schema(props, ["action"]), label="experience")
        act = out.get("action") if out.get("action") in actions else actions[1]
        out["_request"] = f"{request} {ctx.message}".lower()
        return await getattr(self, f"_{act}")(ctx, out, rooms, guests)

    # ---- Climate Vision ----
    async def _climate_vision(self, ctx, out, rooms, guests) -> SkillResult:
        smoke = any(w in out.get("_request", "") for w in ("smoke", "dust", "pollut"))
        room = out.get("room") or ""
        ui: dict[str, Any] = {"type": "climateVision", "on": True}
        if room:
            ui["room"] = room
        if smoke:
            ui["smoke"] = True
        msg = ("Opening **Climate Vision**: the room's air, simulated live from the AC and purifier and drawn in 3D. "
               "Orange is too warm, blue is the AC's cool air, the streaks are the airflow and the haze is dust. "
               + ("I've started a smoke test so you can watch it spread and the purifier clear it. " if smoke else "")
               + "Change the AC or purifier and the picture follows.")
        return SkillResult("success", msg, {"ui": [ui]})

    # ---- comfort ----
    async def _comfort_status(self, ctx, out, rooms, guests) -> SkillResult:
        r = await need_op(self.twin, ctx, "comfort", {"room": out.get("room") or ""} if ctx.is_staff else {})
        if not r.ok:
            return SkillResult("error", f"I can't read the comfort data right now: {r.error}", {"error": r.error})
        rs = (r.data or {}).get("rooms", [])
        if not rs:
            return SkillResult("clarify", "That room has no devices that tell me about comfort.", {})
        if len(rs) > 1:
            worst = sorted(rs, key=lambda x: x["score"])[:5]
            msg = "Comfort by room (lowest first):\n" + "\n".join(f"- **{x['name']}**: {x['score']}/100 ({x['grade']}), {x['temp']} °C" + (f"; {x['advice'][0]}" if x["advice"] else "") for x in worst)
            return SkillResult("clarify", msg, {"ui": [{"type": "setLayer", "layer": "comfort", "on": True}]})
        c = rs[0]
        p = c["parts"]
        msg = (f"**{c['name']}** is at **{c['score']}/100** ({c['grade']}).\n"
               f"- Temperature {c['temp']} °C (target {c['target']} °C): {p['thermal']}"
               + (f", reaching the target in about {c['eta_to_target_min']} min" if c.get("eta_to_target_min") else "") + "\n"
               f"- Air: PM2.5 {c['pm']}, {p['air']}\n- Light: about {c['lux']} lux, {p['light']}\n- Sound: about {c['db']} dB, {p['sound']}\n"
               f"- Humidity {c['hum']} %")
        if c["advice"]:
            msg += "\n\nTo make it better: " + "; ".join(c["advice"]) + ". [[Make it comfortable]]"
        return SkillResult("clarify", msg, {"ui": [{"type": "setLayer", "layer": "comfort", "on": True}, {"type": "selectRoom", "room": c["room"]}]})

    async def _comfort_apply(self, ctx, out, rooms, guests) -> SkillResult:
        room = out.get("room") or (sorted(rooms, key=lambda x: x["score"])[0]["room"] if ctx.is_staff and rooms else "")
        if ctx.is_staff and not room:
            return SkillResult("clarify", "Which room should I make comfortable?", {})
        r = await need_op(self.twin, ctx, "comfort_apply", {"room": room} if ctx.is_staff else {})
        if not r.ok:
            return SkillResult("error", f"I couldn't apply the comfort settings: {r.error}", {"error": r.error})
        d = r.data or {}
        res = d.get("results", [])
        if not res:
            return SkillResult("clarify", f"**{d.get('room')}** is already comfortable ({d.get('score_before')}/100): nothing to change.", {"ui": [{"type": "setLayer", "layer": "comfort", "on": True}]})
        good = [x for x in res if x["ok"]]
        bad = [x for x in res if not x["ok"]]
        msg = (f"Done: {'; '.join(d.get('advice_applied', []))}. Comfort in **{d.get('room')}** went from {d.get('score_before')} to {d.get('score_after')}/100"
               + (" and keeps rising as the room settles." if d.get("score_after", 0) < 90 else ".")
               + (f" {len(bad)} change(s) failed: " + "; ".join(f"{x['name']} {x['command']} ({x.get('error')})" for x in bad) if bad else ""))
        return SkillResult("success" if good else "error", msg, {"device_ids": [x["device_id"] for x in good],
                                                                  "ui": [{"type": "setLayer", "layer": "comfort", "on": True}, {"type": "highlight", "ids": [x["device_id"] for x in good]}]})

    # ---- energy ----
    async def _energy(self, ctx, out, rooms, guests) -> SkillResult:
        r = await need_op(self.twin, ctx, "energy", {"room": out.get("room") or ""} if ctx.is_staff else {})
        if not r.ok:
            return SkillResult("error", f"I can't read the energy data right now: {r.error}", {"error": r.error})
        e = r.data or {}
        av = e.get("avoided_by_automation") or {}
        msg = (f"**{e.get('scope')}** draws **{round(e.get('watts_now', 0))} W** now and used **{e.get('kwh_today', 0):.2f} kWh** today "
               f"({e.get('cost_today')}, {e.get('co2_kg_today', 0):.2f} kg CO2).\n"
               f"- Avoided by the automation today: {av.get('kwh', 0):.3f} kWh ({av.get('cost', 0)} saved, {av.get('co2Kg', 0)} kg CO2)\n"
               + (f"- In eco now: {', '.join(x['name'] + ' (' + x['reason'] + ')' for x in e.get('eco_rooms', []))}\n" if e.get("eco_rooms") else "")
               + "- Biggest loads: " + ", ".join(f"{t['name']} {round(t['watts'])} W" for t in e.get("top_devices", [])[:4])
               + (("\n- By room: " + "; ".join(f"{x['name']} {round(x['w'])} W" for x in e["rooms"][:5])) if e.get("rooms") else ""))
        return SkillResult("clarify", msg, {"ui": [{"type": "setLayer", "layer": "energy", "on": True}], "device_ids": [t["id"] for t in e.get("top_devices", [])[:3]]})

    # ---- journeys ----
    async def _journey_text(self, j: dict[str, Any]) -> str:
        state = {"booked": "checked in, not on the way yet", "en_route": "on the way", "preparing": "being prepared", "ready": "ready",
                 "arrived": "in the room", "away": "away (room in eco)", "departed": "checked out"}.get(j.get("state"), j.get("state"))
        c = j.get("comfort") or {}
        steps = j.get("steps") or []
        done = sum(1 for s in steps if s.get("status") == "done")
        real = sum(1 for s in steps if s.get("real"))
        txt = f"Your room (**{j.get('roomName')}**) is **{state}**."
        if c:
            txt += f" It is {c.get('temp')} °C (you prefer {c.get('target')} °C), comfort {c.get('score')}/100."
            if c.get("etaToTargetMin"):
                txt += f" About {c['etaToTargetMin']} min to your temperature."
        if steps:
            txt += f" Welcome scene: {done} of {len(steps)} done" + (f", {real} on the room's real SmartThings devices" if real else "") + "."
        p = j.get("prefs") or {}
        txt += f" Your preferences: {p.get('temp')} °C, {p.get('scene')} light, curtain {p.get('curtain')} % open."
        return txt

    async def _journey_status(self, ctx, out, rooms, guests) -> SkillResult:
        r = await need_op(self.twin, ctx, "journey")
        j = (r.data or {}).get("journey") if r.ok else None
        if not j:
            return SkillResult("error", "I can't see your stay right now.", {})
        return SkillResult("clarify", await self._journey_text(j), {})

    async def _guest_action(self, ctx, action: str, extra: dict[str, Any] | None = None) -> SkillResult:
        r = await need_op(self.twin, ctx, "journey_action", {"action": action, **(extra or {})})
        if not r.ok:
            return SkillResult("error", f"That didn't work: {r.error}", {"error": r.error})
        j = (r.data or {}).get("journey") or {}
        lead = {"on_my_way": "Thanks, I'll have the room ready when you get there. ", "prepare": "I'm preparing your room now. ",
                "away": "Enjoy your time out: I've set the room to eco and will have it ready again when you're on your way back. ",
                "prefs": "Saved your preferences. "}.get(action, "")
        return SkillResult("success", lead + await self._journey_text(j), {})

    async def _on_my_way(self, ctx, out, rooms, guests) -> SkillResult:
        return await self._guest_action(ctx, "on_my_way", {"minutes": out.get("minutes") or 10})

    async def _away(self, ctx, out, rooms, guests) -> SkillResult:
        return await self._guest_action(ctx, "away")

    async def _prefs(self, ctx, out, rooms, guests) -> SkillResult:
        extra: dict[str, Any] = {"action": "prefs"}
        if out.get("temp"):
            extra["temp"] = out["temp"]
        if out.get("scene"):
            extra["scene"] = out["scene"]
        if isinstance(out.get("curtain"), (int, float)) and 0 <= out["curtain"] <= 100:
            extra["curtain"] = out["curtain"]
        extra.pop("action")
        return await self._guest_action(ctx, "prefs", extra)

    async def _prepare(self, ctx, out, rooms, guests) -> SkillResult:
        if not ctx.is_staff:
            return await self._guest_action(ctx, "prepare")
        token = out.get("guest") or (guests[0]["token"] if len(guests) == 1 else "")
        if not token:
            return SkillResult("clarify", "Which guest's room should I prepare? " + ", ".join(f"{g['guest'] or 'unnamed'} ({g['room']})" for g in guests[:6]), {})
        return await self._staff_journey(ctx, token, "prepare")

    async def _eta(self, ctx, out, rooms, guests) -> SkillResult:
        token = out.get("guest") or (guests[0]["token"] if len(guests) == 1 else "")
        if not token:
            return SkillResult("clarify", "Which guest is arriving?", {})
        return await self._staff_journey(ctx, token, "eta", {"minutes": out.get("minutes") or 15})

    async def _checkout(self, ctx, out, rooms, guests) -> SkillResult:
        token = out.get("guest") or ""
        if not token:
            return SkillResult("clarify", "Which guest is checking out? " + ", ".join(f"{g['guest'] or 'unnamed'} ({g['room']})" for g in guests[:6]), {})
        return await self._staff_journey(ctx, token, "checkout")

    async def _staff_journey(self, ctx, token: str, action: str, extra: dict[str, Any] | None = None) -> SkillResult:
        r = await need_op(self.twin, ctx, "journey_action", {"token": token, "action": action, **(extra or {})})
        if not r.ok:
            return SkillResult("error", f"That didn't work: {r.error}", {"error": r.error})
        j = (r.data or {}).get("journey") or {}
        steps = j.get("steps") or []
        msg = {"prepare": f"Preparing **{j.get('roomName')}** for {j.get('guest') or 'the guest'}: {sum(1 for s in steps if s.get('status') == 'done')} of {len(steps)} welcome steps done.",
               "eta": f"{j.get('guest') or 'The guest'} is expected in about {extra.get('minutes') if extra else ''} min; **{j.get('roomName')}** will be prepared {j.get('leadMin') or 'a few'} min before.",
               "checkout": f"Checked out {j.get('guest') or 'the guest'}: **{j.get('roomName')}** is in eco with the curtain closed, and housekeeping is requested."}[action]
        return SkillResult("success", msg, {"ui": [{"type": "selectRoom", "room": j.get("room")}]})

    async def _journeys(self, ctx, out, rooms, guests) -> SkillResult:
        if not guests:
            return SkillResult("clarify", "No guests are staying right now.", {})
        names = {"booked": "checked in", "en_route": "on the way", "preparing": "room being prepared", "ready": "room ready", "arrived": "in the room", "away": "out (eco)", "departed": "checked out"}
        msg = "Guests:\n" + "\n".join(f"- **{g['guest'] or 'unnamed'}** · {g['room']}: {names.get(g['state'], g['state'])}" + (f", arriving in about {g['eta_min']} min" if g.get("eta_min") is not None else "") for g in guests[:10])
        return SkillResult("clarify", msg, {})

    # ---- predictions / dispatch ----
    async def _predictions(self, ctx, out, rooms, guests) -> SkillResult:
        r = await need_op(self.twin, ctx, "predictions")
        ps = (r.data or {}).get("predictions", []) if r.ok else []
        if not ps:
            return SkillResult("clarify", "No failures are predicted: every device is wearing normally.", {})
        msg = "Predicted failures, soonest first:\n" + "\n".join(
            f"- **{p['name']}** ({p['device_id']}, {p['room']}): {p['title']}, in about **{p['when']}** ({round(p['confidence'] * 100)} % confidence, {p['basis']}). {p['action']}."
            for p in ps[:6])
        first = ps[0]["device_id"]
        msg += f"\n\n[[Send a technician to {first}]]"
        return SkillResult("clarify", msg, {"device_ids": [p["device_id"] for p in ps[:6]], "ui": [{"type": "highlight", "ids": list(dict.fromkeys(p["device_id"] for p in ps[:6]))}]})

    async def _dispatch(self, ctx, out, rooms, guests) -> SkillResult:
        dev = out.get("device_id") or ""
        if not dev:
            return SkillResult("clarify", "Which device should the technician go to?", {})
        r = await need_op(self.twin, ctx, "dispatch_tech", {"device_id": dev})
        if not r.ok:
            return SkillResult("error", f"I couldn't dispatch a technician: {r.error}", {"error": r.error})
        x = (r.data or {}).get("dispatch") or {}
        who = (x.get("tech") or {}).get("name") or "A technician"
        return SkillResult("success", f"**{who}** is on the way to {dev} from {x.get('fromName')}: {x.get('reason')}. The route is shown on the map.",
                           {"device_ids": [dev], "ui": [{"type": "dispatchRoute", "id": dev}]})
