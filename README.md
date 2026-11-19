# Agentic Digital Twin · Map View

Proof of concept: a smart home floor as a live 3D map (Godot 4.7), with devices that open in place into
their internal parts, animated refrigerant piping, guided troubleshooting, and an AI agent that finds,
explains and controls devices and drives the map. All device data is simulated.

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

# 3. Renderer: desktop (Forward+), reads the same platform
godot --path godot-renderer
#    or export the web build into web/public/godot/ (needs 4.7 export templates)
godot --headless --path godot-renderer --export-release "Web"
```

Open http://localhost:3000. Without the Godot web export the page shows a placeholder in place of the 3D view;
the device list, side panel, timeline and chat still work.

Try in the chat: "which air conditioners have a problem?", "what's wrong with ODU-01", "set AC-01 to 24 degrees",
"unlock the front door" (the agent asks for confirmation first). Pick a scenario in the timeline bar.

## Tests

```bash
cd agent-backend && pytest                              # search, tools, demo mode, eval cases
cd web && npm run typecheck && npm run build
cd godot-renderer && godot --headless --path . -- --smoke   # drives every bridge command
```

## Status

Phase 1 scaffold: all three parts run together end to end. Device bodies and parts in Godot are primitives;
the rendering showcase (modelled parts, GI, section plane, thermal mode, tour) is phases 2–9 in
[docs/PROMPT.md](docs/PROMPT.md).
