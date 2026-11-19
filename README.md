# Agentic Digital Twin · Map View

Proof of concept with three features:

1. **Floor plan to 3D map.** Upload a floor plan image (a phone photo of a printed sheet is straightened first), let AI
   detect the rooms and the interiors drawn on it (or draw them), and render it as a 3D map view in Godot with walls,
   doors, columns, modelled furniture, stairs, sanitary ware and the labels printed on the plan.
2. **Drag and drop devices.** The floor starts without devices (a plan doesn't show them). Drag SmartThings devices
   from the palette onto the 3D map: each type snaps where it is installed (wall units on the nearest wall facing the
   room, locks beside a door, lights on the ceiling, appliances on the floor). Move or remove them from the side panel.
3. **Device digital twin.** Click any device: it opens in place into its internal components (5 to 16 per type), with
   the internal flows between them and the device's connections (refrigerant cycle, cooled and warm air, water, drain,
   power, signal), the piping to the rest of the system and synthetic live data per part and per flow.
4. **AI agent.** Search devices and see them highlighted on the map, get insights on what is wrong and what
   to do, and control devices (risky commands need confirmation).

All device data is simulated.

| Folder | What | Stack |
|---|---|---|
| [`agent-backend/`](agent-backend) | AI agent: device search, insights, control (with confirmation), map actions | Python, FastAPI, Claude tool use |
| [`godot-renderer/`](godot-renderer) | 3D renderer: floor, devices, piping, opened-device internals | Godot 4.7, GDScript |
| [`web/`](web) | Product UI (3D view, side panel, chat, timeline) + simulated device platform API | Next.js, TypeScript |
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
pip install -e ".[dev]"
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
the device list, side panel, timeline and chat still work. `next start` only serves files that existed when it
started, so restart it after exporting.

To use your own plan: open http://localhost:3000/setup (or "Upload floor plan" in the header). A phone photo of a
printed sheet can be straightened there first. Room detection needs `ANTHROPIC_API_KEY`; without it, draw the rooms.

Default floor: with the private 4F files installed ([docs/plans/samsung-rnd-4f](docs/plans/samsung-rnd-4f)), the platform
starts on the 4th floor (28 rooms, doors, interiors and the sheet's labels, no devices) so the map shows it without
any upload; without them it starts on a small built-in home. In the editor, "4F plan (traced)" and "4F photo (straighten)" load the same files.

Try in the chat: "which air conditioners have a problem?", "what's wrong with ODU-01", "set AC-01 to 24 degrees",
"unlock the front door" (the agent asks for confirmation first). Pick a scenario in the timeline bar.

## Tests

```bash
cd agent-backend && pytest                              # search, tools, demo mode, eval cases
cd web && npm run typecheck && npm run build
cd godot-renderer && godot --headless --path . -- --smoke   # drives every bridge command
```

## Status

All three parts run together end to end, verified with the Godot web build inside the page (WebGL 2) and the
desktop build on Forward+ (Vulkan). Rooms can be any polygon; piping routes along walls; the device twin shows
parts where they sit in the real unit, with internal flows driven by live readings. See "Accuracy rules" in
[docs/PROMPT.md](docs/PROMPT.md). Part shapes are still primitives; modelled parts, GI, section plane, thermal
mode and the guided tour are phases 2–9.
