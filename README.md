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

0. **No pillars.** The drawing's structural columns are left out of the 3D floor so they don't block views and walks.
0. **Lift lobby.** In Zone D, between two rows of three lift shafts (the drawing's large boxes): L1-L3 with steel
   doors and call buttons, L4-L6 with panelled doors, blue walls, wood-plank floor, an oval lit ceiling with
   downlights. Its door onto the passage always stands open, and across the passage are the main cafeteria's glass
   double doors with the EXIT sign and the water bottles beside them. Guests arrive here: the walk starts inside the middle steel lift with its doors shut; the doors slide open, the
   guest steps out, turns towards the way to go while the doors close behind, then sets off.
0. **SmartThings Experience Zone, modelled as it is.** The zone is a real, already fitted room and the floor starts
   with it furnished (the plan draws it a little small to walk round in 3D, so it is enlarged by about a fifth each
   way, taken from the Maternity and Medical rooms beside it) and its SmartThings devices installed, laid out from
   photos of the room. Walking in through the frosted glass door (at the end of the corridor wall next to the TV
   wall: the traced plan had it at the other end, which mirrored the room), the open glass leaf rests on the
   **TV wall on your right**: the 65" TV on its walnut unit, Light 1 (a bulb on the wall behind the TV), Light 5 (by
   the door) and Light 2 (above the TV) on the lowered band, a floor lamp in the far corner. **Straight ahead, the
   window wall**: the back-lit window (Left / Right Window Light: a lit pane shows the outdoor view with drifting
   clouds, an unlit one is dark glass) under the Aqara Roller Shade Controller (the Blinds Switch by its right end
   powers its motor and is switched on by itself when the shade moves), Light 4 above the shade's left end, the
   side lamp (in a standing lamp), the white bookcase in the left corner with Light 3 above it. **The door wall**:
   a floor lamp, the coral Bespoke air purifier, the desk under the wall TV into the corner. **The left wall**: the
   desk return with the Desk Lamp and flowers, the framed print. In the middle the grey tufted sofa faces the TV
   across the coffee table. Drop ceiling with LED panels (they follow the TV Lamp, the main ceiling lights), AC
   diffusers and the lowered band along the TV and window walls where the spot bulbs hang; cameras in three corners
   (never shown to guests); door lock, temperature sensor, ceiling AC. Each device has its fixture (`spot`,
   `wall`, `lamp`, `desk`, `panel`, `window`, `roller`, `bespoke`) so the 3D view draws it as it is fitted. With a
   SmartThings token they are linked to the real devices by deviceId at once (see 12 below); the account's
   "Aqara Roller Shade Controller of dining" is not in this room and is never placed or linked here. A guest QR can
   be made for it straight away; every other room needs Hotel setup first (the room card says so and the API
   refuses a pass for a room without its devices). Layout: `web/lib/sim/stzone.ts`; reference views of the 3D
   room from the photos' viewpoints: `godot --path godot-renderer -- --zone-shots=/tmp/zone`.

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
   choice; by default the lift lobby in Zone D: the guest steps out of the middle lift and walks out through the
   lobby's open door to the corridor; on any other floor from where a visitor really comes in: of the doors to the
   outside, the one into a hall, corridor, lobby or living area, with the most doors and the widest opening, never
   into a bedroom, bathroom, store or balcony, and never the room itself; else the floor's main hall) to the room
   along a route drawn on the floor with
   tags where it enters the corridor, stairs and the room; they can pick another starting point, see the way from
   above or skip. Only rooms on the way open; other doors stay shut and show nothing.
   **Live indoor position** ("Find me" on the guest page): the view follows the guest's real position, snapped
   to walkable floor and re-routed to the room. Fixes come from the hotel's positioning system (UWB/BLE badge
   bound to the pass at check-in, posted to `/api/positioning/rtls` with its key), from location QR codes on the
   walls (one beside every door and in each stair or lift; print them from `/integrations`, scan with the phone
   camera), and in between from the phone's step counting and compass. "Simulate a badge" replays the route as
   an RTLS would, for demos without hardware. Every fix is map-matched with continuity
   (`WalkNav.match_fix`): of the walkable spots near the fix, the one reachable from the last position within the
   distance anyone could have walked since, so badge noise never puts the guest through a wall into the next room;
   the "you are here" marker then walks the route there through the doorways. Step tracking carries on from the
   matched spot, so it does not drift through walls either. The panel shows the metres and walking time left to the
   room and where the guest is now; at the door it offers "Unlock" (with the PIN, as the policy asks). The
   renderer test `--live-check` feeds noisy fixes, and fixes pushed to the wrong side of a wall, along four routes:
   no fix is matched across a wall (plain nearest-floor snapping crossed 1 to 6 times per run).
9. **Room tour and 3D controls.** On entering, the view steps to where the whole room is in view (the open floor farthest from its middle that still sees it) and turns to take it in. In the room a guided tour turns to each device and says what it does. Tapping a
   device (in 3D or in the list) turns the view to it and pins its control beside it in the room, with a glowing
   ring around the device: a climate dial for the AC (drag round the ring; mode chips, fan bars), a light beam
   you drag up or down with a warm-to-daylight strip and scenes, a roller you pull for blinds and the projector
   screen, a TV remote, a speed ring for the purifier or fan and a hold-to-unlock ring for the door. While a
   control is dragged the room already shows the result and the new value floats over the device; the command is
   sent when the guest lets go. The control can be dragged anywhere over the 3D view by its grip or title bar (a
   dashed line keeps it tied to its device; double-click the grip to put it back). The side panel shows states only. In the SmartThings Experience Zone the 3D control
   for the room's SmartThings app devices is a SmartThings app tile pinned beside the device:
   colour bulbs (Light 1-5, Desk lamp) have a brightness bar that glows in the light's colour, Night / Relax / Read
   / Day scenes and colour pills (pink, purple, and more on a colour strip); TV lamp, Left and Right window, side
   lamp and blinds switch are on/off switches; the Aqara roller shade has a shade-level slider drawn as a rolling
   curtain, and the light's place in the room is named (Behind the main TV, …). The zone's other devices
   (AC, TVs, purifier, lock) keep the controls above. The room reacts in 3D: lights brighten or dim the room (with colour), the AC
   blows air coloured by mode and swings its louver, the floor tints cool or warm, the TV screen plays, blinds go up
   and let daylight in, the fan spins and sweeps, the purifier ring shows air quality, the vacuum cleans the room,
   the AC cools the room over time, offline devices go grey.
10. **Guest AI assistant.** Typed or spoken (English or Bangla) requests such as "Set the AC to 24 degrees and dim
    the lights" or "Make the room comfortable for sleeping": the assistant shows the planned actions, asks first for
    broad wishes, runs them and reports each device's result, including partial failures (a device offline). It
    uses Claude when `ANTHROPIC_API_KEY` is set and a rule-based reader otherwise, always through the guest API.
12. **Real devices and door access** (`/integrations`). Paste a SmartThings personal access token and press
    Connect: the token is checked and every device in the account is fetched with its room and category
    (`GET /v1/devices`, `/v1/locations/{id}/rooms`) and put on the map (`web/lib/integrations/stsync.ts`). On the
    4th floor a device goes to the SmartThings Experience Zone, as the room is set up now: a twin device with the
    same name is linked to it; otherwise a twin device of the same type that no real device is named after takes it
    over (renamed, same spot); otherwise it is added at a free spot that suits its type (wall, ceiling or floor).
    A device whose SmartThings room is named after another room of the floor goes there. On other floors, devices
    go to the room with their SmartThings room's name. Hubs and phones are skipped; twin devices left without a real
    one stay simulated and can be removed in one click. Every command (host, guest, assistants, policy) to a linked
    device then goes to the SmartThings API, and its reported status and online state replace the simulated values. Unlocking follows the hotel's access policy: only the guest's own door, only
    if the pass allows it, after the check-in PIN, with the PIN asked again after a set time, a limit on unlocks,
    automatic relocking, and an audit log of every attempt.
    **The zone's 12 real devices are known by deviceId** ([docs/smartthings-zone-devices.md](docs/smartthings-zone-devices.md),
    `web/lib/integrations/zone-devices.ts`): with `SMARTTHINGS_TOKEN` in `web/.env` they are linked as soon as the app
    starts, without Connect. Their status is read every 2 s in one batched request (`SMARTTHINGS_POLL_MS`), so a
    change made in the SmartThings app or at a wall switch shows on the 3D twin within about 2-3 s; a command's
    value is held on the twin until the device reports it, colour bulbs show the colour or white they were set to
    last, and an offline device is greyed out (`web/lib/integrations/stlive.ts`). In the 3D view no text is drawn over devices (their state is in the side panel): the room
    itself shows it. Spot bulbs show their beam, a pool of light on the floor and a scallop on the wall; lamp shades
    are lit only while their bulb is on; panes, the shade and the ceiling panels follow their devices; when a real
    device changes, a soft ring pulses out from it. Walking in, you stand just inside the door looking across the
    room (the room's `view`), with a wide, phone-camera-like field of view; materials are made to match the photos
    (varnished oak panels, cream porcelain tiles, speckled mineral ceiling tiles, maple desks, grey velvet sofa) and
    the walk-through is graded like an interior photo (warm fill light, ACES tone mapping).
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

## Story mode: one guest, one night

Open `/story` for a guided showcase on the live system (nothing is recorded: every step calls the platform and
the renderer). Five chapters on the 4th floor, with captions and a phone beside the 3D view:

1. **The building comes alive.** The fire-safety drawing builds into the 3D floor; a wave of light runs across
   every SmartThings device as it reports in; the AC circuits show; the camera settles on the SmartThings
   Experience Zone, tonight's Room 401.
2. **Check-in, lift, welcome.** The front desk issues a pass (QR on the phone). The guest arrives by lift, follows
   his route, the door unlocks for his pass only, and the room welcomes him: lights fade up, the curtain rises over
   the lit window, the AC starts and the TV says "Welcome, Marufur".
3. **The smart stay.** He types "I'm a bit cold. Dim the lights, it's movie time." The assistant plans it (AC 2°
   warmer, dimmable lights down, on/off lights off, curtain closed, TV on), asks first, then runs it on the devices.
4. **Something breaks.** At 02:10 the AC develops a refrigerant fault; the twin highlights it, opens the unit into
   its parts (X-ray), the assigned technician gets the alert on his phone, walks the route to the unit in first
   person, and the fix clears it.
5. **The operator's view.** The floor at night with each room coloured by tonight's energy; at checkout the pass
   ends and the room switches itself off, with the energy saved.

Presenter mode: the Next button, → / space / Page Down (a presentation clicker works), ← for the previous chapter,
1-5 to jump, Esc to stop. `/story?autoplay=1` plays by itself and loops (for a screen or kiosk). The guest is
fictional; chapter 3 uses the guest assistant (with Claude when `ANTHROPIC_API_KEY` is set, else the built-in
rules) and falls back to the same changes made directly if the assistant is not running.

## Full screen, tablets and browsers

The map on the host page, the technician console and the guest page has a full-screen button (in the map
controls, or top right of the map): the map with everything floating over it fills the screen, and Esc or the
button again goes back. It uses the Fullscreen API (Chrome, Firefox, Edge; the webkit form on iPad Safari);
where a browser has none (iPhone) the map is stretched over the window instead.

Laptop and tablet layouts: the header keeps rooms, building, floor, devices and alerts on one line on laptops and
wraps to two lines on tablets; below 900 px the side panel moves under the map. Touch screens get bigger map
controls. The 3D view is a single-threaded WebGL 2 export, so it needs no cross-origin isolation headers and runs
in Firefox as in Chrome. Browser features that only some browsers have fall back: voice input (no microphone
button in Firefox), QR scanning in the page (otherwise the phone camera opens the code's link), notifications.
Tested here with Chromium at 1366x768, 1180x820 and 820x1180 with touch; Firefox could not be installed in the
build environment, so check it on a real machine.

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

The app starts by asking for a floor plan (http://localhost:3000 sends you to /setup until one is built). Upload the
image and it is read straight away; check the names, the building and floor, and the scale, then render. The floor
last built is kept in `web/.data/floor.json` and comes back after a restart (devices placed later are not kept).
"Upload floor plan" in the header replaces it. What the reader does (agent-backend/app/plan_cv.py, OpenCV + Tesseract):

- a photo of a sheet taken at an angle is recognised from the paper outline and straightened on its corners
  automatically, then read again (the handles stay in "Straighten photo" for fine-tuning);
- walls are the thickest long strokes (text, furniture, dimension lines and filled columns are set apart), with
  several readings tried (solid, hatched, cross-hatched, thin-line walls) and the most plausible kept; hatched walls
  are filled solid first, and OCR "letters" found inside hatching are not mistaken for text;
- door openings are closed by casting a ray from every wall end along its wall; a closure between two spaces is a door,
  and openings in the outer wall are entrances;
- each enclosed space is a room, grown to the wall centre lines so neighbours share walls, and squared up;
- room names come from text printed inside each room; the floor ("Ground floor", "Level 3") from the sheet's title;
  the scale from the door widths (about 0.85 m each);
- the drawing under the 3D floor is cleaned: cropped to the building, with everything outside it (title block, legend,
  notes, dimension chains, frame) turned to plain paper and the printed text inside erased. Walls, hatching, door
  swings and furniture outlines stay; the 3D map prints the room names itself.

With `ANTHROPIC_API_KEY` set, Claude vision runs at the same time: it names rooms the text reader could not, adds rooms
with no walls drawn around them, and lists the furniture drawn on the plan. Everything stays editable: draw, reshape,
rename or delete rooms, add or remove doors, set the real plan width, switch the suggested furniture on or off.
Devices are added afterwards by dragging them onto the 3D map.

The 4th floor: an upload of the Samsung R&D 4th-floor plan looks like any other upload, but it is recognised
(agent-backend/app/known_plans.py) and built from the hand-checked model in `web/lib/presets/samsung-rnd-4f.json`,
with the SmartThings Experience Zone, the lift lobby and its devices. Recognition matches the drawing itself (ORB
features and a homography against the reference images, so scans, crops, rotations and phone photos all match) when the
private drawing is installed in `web/public/presets/` ([docs/plans/samsung-rnd-4f](docs/plans/samsung-rnd-4f)), and
otherwise the room names printed on it. Phone photos of the sheet work too: the photo is straightened, and the
paper is evened out before reading (grey, unevenly lit paper next to the whitened desk used to read as one dark
page, so no names were found). Story mode needs this floor.

Device IDs on the 3D map are off by default; "Device IDs" in the map toolbar shows them (a hovered or selected device
always shows its ID).

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
