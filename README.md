# Agentic Digital Twin · Map View

Proof of concept with three features:

1. **Floor plan to 3D map, for any plan.** Upload any floor plan image (a phone photo of a printed sheet is
   straightened first). The plan reader finds walls, room outlines, door openings, the scale and the room names printed
   on it, with image processing that needs no API key; with a key, Claude vision adds names and the furniture drawn on
   the plan. Rooms without detected furniture get a suggested fit-out by room type. Review and correct everything in
   the editor, then render it as a 3D map view in Godot with walls, doors, modelled furniture, stairs, sanitary ware
   and the room labels. The traced 4th-floor sheet is the built-in sample.
2. **Drag and drop devices.** The floor starts with devices only in the SmartThings Experience Zone (below); other
   rooms start empty (a plan doesn't show devices). Drag SmartThings devices
   from the palette onto the 3D map: each type snaps where it is installed (wall units on the nearest wall facing the
   room, locks beside a door, lights on the ceiling, appliances on the floor). Move or remove them from the side panel.
3. **Device digital twin.** Click any device: it opens in place into its internal components (5 to 16 per type), with
   the internal flows between them and the device's connections (refrigerant cycle, cooled and warm air, water, drain,
   power, signal), the piping to the rest of the system and synthetic live data per part and per flow.
4. **Fault simulation for technicians.** Every device type has a catalogue of realistic faults (55 in all: a
   clogged AC filter, a refrigerant leak, worn fan bearings, a blocked drain, a seized outdoor fan, an inverter trip,
   a fridge defrost failure, a blocked washer pump, an overloaded plug, low batteries, weak radios…). Pick a fault
   and a severity (early, developing, severe) in the device panel: it develops over a few seconds and the twin shows
   it where it happens. Damaged components glow red, flows through them stop, the readings change (airflow,
   pressures, currents, temperatures), motors vibrate, coils frost, filters clog. The panel gives the diagnosis with
   live evidence and a guided repair, each step flying the camera to its component.
5. **AI agent.** Search devices and see them highlighted on the map, get insights on what is wrong and what
   to do, and control devices (risky commands need confirmation).

**Hotel use case** (the 4th floor is treated as a hotel floor):

0. **SmartThings Experience Zone, modelled as it is.** The zone is a real, already fitted room and the floor starts
   with it furnished and its SmartThings devices installed: wood-panelled walls, cream floor tiles, a drop ceiling
   with LED panels and AC diffusers and a lowered band for the spot bulbs, a grey tufted sofa facing a 65" TV on a
   walnut unit, a coffee table, a roller projector screen, four brass floor lamps, a white bookcase beside the
   panelled column, an L-desk with chairs under a wall TV, a Bespoke air purifier and a frosted glass door. Its
   lights and curtain carry the names they have in the zone's SmartThings app (room 401): Light 1 (back of the main
   TV), Light 2 (top of the TV), Light 3 (above the shelf), Light 4 (between the curtain and the shelf), Light 5
   (door entrance), Desk lamp, TV lamp (the main ceiling lights; the LED ceiling panels follow it), aqara roller
   shade control (the white roller curtain), blinds switch (powers the curtain motor; it is switched on by itself
   when the curtain is moved), Left window and Right window (lights behind the curtain), side lamp (dining room)
   (the big standing lamp). Also in the room: ceiling cassette AC, two TVs, purifier, door lock, temperature
   sensor and two indoor cameras (never shown to guests). On `/integrations`, "Link by name" links them to the
   real devices in one step. A guest QR can be made for it straight away; every other room needs Hotel setup
   first (the room card says so and the
   API refuses a pass for a room without its devices). Layout: `web/lib/sim/stzone.ts`.

6. **Hotel set-up.** "Hotel setup" (or "Set up as guest room" on a clicked room) refurnishes suitable rooms as guest
   rooms (bed, nightstands, desk, armchair) and fits the usual devices on the right walls: AC, TV, ceiling and
   reading lights, blinds on the outside wall, minibar, fan, air purifier, robot vacuum, a door lock beside the door
   and a temperature sensor. Hosts control any device from its panel; controls come from what the device supports
   (AC: power, temperature, mode, fan speed, louver, off timer; TV: power, volume, source; lights: brightness and
   colour; fan: speed and oscillation; blinds; purifier; vacuum; lock).
7. **Time-limited guest access by QR code.** Click a room, "Guest QR code": guest name, checkout time, an optional
   check-in PIN (identity check at the desk) and, by hotel policy, whether the verified guest may unlock their door
   (through the lock integration below). Passes expire at checkout and can be withdrawn. A guest only ever reaches
   `/api/guest/<token>/…`, which returns and controls nothing outside their room. Optional `ADMIN_KEY` keeps the
   host pages and APIs behind a sign-in (`?key=…` once).
8. **3D guidance to the room.** After scanning, the guest enters the PIN and walks in 3D from an entrance (the host's
   choice, or a lift, lobby or stair, or a door to the outside) to the room along a route drawn on the floor with
   tags where it enters the corridor, stairs and the room; they can pick another starting point, see the way from
   above or skip. Only rooms on the way open; other doors stay shut and show nothing.
   **Live indoor position** ("Find me" on the guest page): the view follows the guest's real position, snapped
   to walkable floor and re-routed to the room. Fixes come from the hotel's positioning system (UWB/BLE badge
   bound to the pass at check-in, posted to `/api/positioning/rtls` with its key), from location QR codes on the
   walls (one beside every door and in each stair or lift; print them from `/integrations`, scan with the phone
   camera), and in between from the phone's step counting and compass. "Simulate a badge" replays the route as
   an RTLS would, for demos without hardware.
9. **Room tour and 3D controls.** In the room a guided tour turns to each device and says what it does. Tapping a
   device (in 3D or in the list) turns the view to it and pins its control beside it in the room, with a glowing
   ring around the device: a climate dial for the AC (drag round the ring; mode chips, fan bars), a light beam
   you drag up or down with a warm-to-daylight strip and scenes, a roller you pull for blinds and the projector
   screen, a TV remote, a speed ring for the purifier or fan and a hold-to-unlock ring for the door. While a
   control is dragged the room already shows the result and the new value floats over the device; the command is
   sent when the guest lets go. In the SmartThings Experience Zone the room's SmartThings app devices are shown
   the way the SmartThings app shows them, grouped under the app's rooms (Living room, Bedroom, Dining room):
   colour bulbs (Light 1-5, Desk lamp) have a brightness bar that glows in the light's colour, Night / Relax / Read
   / Day scenes and colour pills (pink, purple, and more on a colour strip); TV lamp, Left and Right window, side
   lamp and blinds switch are on/off switches; the Aqara roller shade has a shade-level slider drawn as a rolling
   curtain. Tapping a tile's name turns the 3D view to the device and pins the same tile, larger, beside it. The
   zone's other devices (AC, TVs, purifier, lock) keep the controls above. The room reacts in 3D: lights brighten or dim the room (with colour), the AC
   blows air coloured by mode and swings its louver, the floor tints cool or warm, the TV screen plays, blinds go up
   and let daylight in, the fan spins and sweeps, the purifier ring shows air quality, the vacuum cleans the room,
   the AC cools the room over time, offline devices go grey.
10. **Guest AI assistant.** Typed or spoken (English or Bangla) requests such as "Set the AC to 24 degrees and dim
    the lights" or "Make the room comfortable for sleeping": the assistant shows the planned actions, asks first for
    broad wishes, runs them and reports each device's result, including partial failures (a device offline). It
    uses Claude when `ANTHROPIC_API_KEY` is set and a rule-based reader otherwise, always through the guest API.
12. **Real devices and door access** (`/integrations`). Connect a SmartThings account (personal access token, or
    `SMARTTHINGS_TOKEN`) and link twin devices to real ones: every command (host, guest, assistants, policy) then
    goes to the SmartThings API, and the device's reported status and online state replace the simulated values;
    unlinked devices stay simulated. Unlocking follows the hotel's access policy: only the guest's own door, only
    if the pass allows it, after the check-in PIN, with the PIN asked again after a set time, a limit on unlocks,
    automatic relocking, and an audit log of every attempt.
11. **Technician alerts.** `/tech` lists alerts from devices that are not healthy (with browser notifications for
    new ones): room and device, what it reports, affected components (measured or not), recent events,
    troubleshooting steps, service notes, the 3D twin, an AI summary of the evidence, and a form to record the
    investigation (status, cause, action, notes). Records show as the device's maintenance history.

Map navigation works on any floor size (the camera is sized to the floor): zoom toward the cursor, pan, orbit,
fit the whole floor, plan (2D) view and 45° rotation, from the controls on the right of the map, the mouse, touch
or the keyboard (arrows/WASD, + −, Q E, F, T).

Walk through: the walking-person button drops you to eye height inside the floor. Walls reach the ceiling and
you enter rooms through their doorways (rooms the plan leaves closed get a doorway on their clearest shared
wall). Drag to look, click or tap the floor to walk there along the shortest route, or use W A S D, the wheel,
a two-finger pinch or the on-screen stick; "Walk to a room" follows the route for you; Esc goes back to the map.

All device data is simulated.

| Folder | What | Stack |
|---|---|---|
| [`agent-backend/`](agent-backend) | AI agent: device search, insights, control (with confirmation), map actions | Python, FastAPI, Claude tool use |
| [`godot-renderer/`](godot-renderer) | 3D renderer: floor, devices, piping, opened-device internals | Godot 4.7, GDScript |
| [`web/`](web) | Product UI (3D view, device palette, side panel, chat) + simulated device platform API | Next.js, TypeScript |
| [`docs/`](docs) | Build brief ([PROMPT.md](docs/PROMPT.md)) and contracts between the parts | |

```
Browser ── Next.js page ──postMessage──▶ Godot web build (iframe)
   │            ▲   ◀──deviceClicked / partClicked──┘
   │      SSE /api/events                 │ polls /api/floor, /api/devices/:id
   │            │                         ▼
   │      Next.js Route Handlers = simulated device platform
   └─/api/chat─▶ agent-backend /chat ──tools──▶ platform
                   └─ ui_action events ─▶ page ─▶ Godot
```

## Run locally

Requirements: Node 20+, Python 3.11+, Godot 4.7.x.

```bash
# 1. Web app + simulated platform  → http://localhost:3000
cd web && npm install && npm run dev

# 2. Agent  → http://localhost:8000
cd agent-backend
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"     # includes OpenCV for the floor plan reader
# optional, for reading room names printed on plans: apt install tesseract-ocr  (or brew install tesseract)
cp .env.example .env        # add ANTHROPIC_API_KEY, or leave empty for demo mode
uvicorn app.main:app --reload --port 8000

# 3. Renderer
#    desktop showcase (Forward+), reads the same platform:
godot --path godot-renderer
#    web build shown inside the page (install the web templates once, then export, then restart the web app):
godot-renderer/tools/install_web_templates.sh
godot --headless --path godot-renderer --export-release "Web"   # writes web/public/godot/
```

Open http://localhost:3000. Without the Godot web export the page shows a placeholder in place of the 3D view;
the device list, side panel and chat still work. `next start` only serves files that existed when it
started, so restart it after exporting.

To use your own plan: open http://localhost:3000/setup (or "Upload floor plan" in the header), upload the image and
press "Read the plan". What the reader does (agent-backend/app/plan_cv.py, OpenCV + Tesseract):

- a photo of a sheet taken at an angle is recognised from the paper outline, and the editor asks you to straighten it;
- walls are the thickest long strokes (text, furniture, dimension lines and filled columns are set apart), with
  several readings tried (solid, hatched, thin-line walls) and the most plausible kept;
- door openings are closed by casting a ray from every wall end along its wall; a closure between two spaces is a door,
  and openings in the outer wall are entrances;
- each enclosed space is a room, grown to the wall centre lines so neighbours share walls, and squared up;
- room names come from text printed inside each room; the scale from the door widths (about 0.85 m each).

With `ANTHROPIC_API_KEY` set, Claude vision runs at the same time: it names rooms the text reader could not, adds rooms
with no walls drawn around them, and lists the furniture drawn on the plan. Everything stays editable: draw, reshape,
rename or delete rooms, add or remove doors, set the real plan width, switch the suggested furniture on or off.
Works best on clean architectural plans; on dense CAD prints (thin double-line walls, hundreds of symbols) expect to
fix rooms by hand or use the vision model. Devices are added afterwards by dragging them onto the 3D map.

Default floor: the platform starts on the traced 4th floor (28 rooms, doors, interiors and the sheet's labels, no
devices), stored in `web/lib/presets/samsung-rnd-4f.json` without the drawing. With the private drawing installed in
`web/public/presets/` ([docs/plans/samsung-rnd-4f](docs/plans/samsung-rnd-4f)), it is also laid under the floor, and the
editor's "4F plan (traced)" and "4F photo" samples work. "Default floor" in the editor returns to it.

Try in the chat: "which air conditioners have a problem?", "what's wrong with ODU-01", "set AC-01 to 24 degrees",
"unlock the front door" (the agent asks for confirmation first).

## Tests

```bash
cd agent-backend && pytest                              # search, tools, demo mode, eval cases, guest assistant
cd web && npm run typecheck && npm run build
# after every pull: cd web && npm install && npm run export:renderer && npm run build && npm start
cd web && npm run test:faults                           # every fault × severity: readings, parts, diagnosis
cd godot-renderer && godot --headless --path . -- --smoke   # drives every bridge command
cd godot-renderer && godot --path . -- --camera=/tmp/camera # fit, zoom range, plan view, rotate, pan limits on 8 m to 300 m floors
cd godot-renderer && godot --path . -- --place=/tmp/place   # drag and drop 21 devices (platform running)
cd godot-renderer && godot --path . -- --walk=/tmp/walk     # walk-through: every room reachable, routes through doorways, no wall crossing
cd godot-renderer && godot --headless --path . -- --guest=<token> --guest-check=/tmp/guest  # guest walk (pass without PIN)
cd godot-renderer && godot --path . -- --fx-shots=/tmp/fx --fx-room=<key>  # screenshots of a room reacting to its devices
cd godot-renderer && godot --headless --path . -- --guest=<token> --live-check=/tmp/live  # following noisy live position fixes
```

## Status

All three parts run together end to end, verified with the Godot web build inside the page (WebGL 2) and the
desktop build on Forward+ (Vulkan). Rooms can be any polygon; piping routes along walls; the device twin shows
parts where they sit in the real unit, with internal flows driven by live readings. See "Accuracy rules" in
[docs/PROMPT.md](docs/PROMPT.md). Part shapes are still primitives; modelled parts, GI, section plane, thermal
mode and the guided tour are phases 2–9.
