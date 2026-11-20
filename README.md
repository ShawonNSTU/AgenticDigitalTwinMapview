# Agentic Digital Twin · Map View

Proof of concept with three features:

1. **Floor plan to 3D map, for any plan.** Upload any floor plan image (a phone photo of a printed sheet is
   straightened first). The plan reader finds walls, room outlines, door openings, the scale and the room names printed
   on it, with image processing that needs no API key; with a key, Claude vision adds names and the furniture drawn on
   the plan. Rooms without detected furniture get a suggested fit-out by room type. Review and correct everything in
   the editor, then render it as a 3D map view in Godot with walls, doors, modelled furniture, stairs, sanitary ware
   and the room labels. The traced 4th-floor sheet is the built-in sample.
2. **Drag and drop devices.** The floor starts without devices (a plan doesn't show them). Drag SmartThings devices
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

Map navigation works on any floor size (the camera is sized to the floor): zoom toward the cursor, pan, orbit,
fit the whole floor, plan (2D) view and 45° rotation, from the controls on the right of the map, the mouse, touch
or the keyboard (arrows/WASD, + −, Q E, F, T).

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
cd agent-backend && pytest                              # search, tools, demo mode, eval cases
cd web && npm run typecheck && npm run build
cd web && npm run test:faults                           # every fault × severity: readings, parts, diagnosis
cd godot-renderer && godot --headless --path . -- --smoke   # drives every bridge command
cd godot-renderer && godot --path . -- --camera=/tmp/camera # fit, zoom range, plan view, rotate, pan limits on 8 m to 300 m floors
cd godot-renderer && godot --path . -- --place=/tmp/place   # drag and drop 21 devices (platform running)
```

## Status

All three parts run together end to end, verified with the Godot web build inside the page (WebGL 2) and the
desktop build on Forward+ (Vulkan). Rooms can be any polygon; piping routes along walls; the device twin shows
parts where they sit in the real unit, with internal flows driven by live readings. See "Accuracy rules" in
[docs/PROMPT.md](docs/PROMPT.md). Part shapes are still primitives; modelled parts, GI, section plane, thermal
mode and the guided tour are phases 2–9.
