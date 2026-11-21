# web

Next.js app: the product page around the Godot 3D view, plus the simulated device platform that the
renderer and the agent read.

```bash
npm install
npm run dev        # http://localhost:3000
```

`ST_AGENT_URL` points the `/api/chat` routes at the assistant (smartthings-agent, Ollama); `AGENT_URL` at the floor-plan service (agent-backend).

| Path | Purpose |
|---|---|
| `app/setup/page.tsx`, `components/PlanEditor.tsx` | floor plan upload: AI room detection, draw/rename rooms, place or auto-place devices, set scale, render |
| `lib/layout.ts` | plan coordinates → metres, typical devices per room, ids |
| `app/page.tsx` | layout: 3D view, side panel (agent chat, device list, device detail), timeline |
| `components/TwinView.tsx` | iframe host for the Godot web export in `public/godot/` |
| `components/DevicePanel.tsx` | health, finding, guided steps, live parts |
| `components/ChatPanel.tsx` | streams agent answers; forwards `ui_action` to the renderer |
| `components/Timeline.tsx` | play, scrub, scenario |
| `lib/bridge.ts` | typed postMessage bridge ([contract](../docs/contracts/bridge-api.md)) |
| `lib/sim/engine.ts` | simulator: scenarios, readings, part health, findings (ported from the HTML prototype) |
| `lib/sim/runtime.ts` | clock, command whitelist and overrides |
| `app/api/*` | platform API ([contract](../docs/contracts/platform-api.md)) |

Uploading a plan replaces the layout in memory (`POST /api/building`); the simulator re-picks which devices
each scenario acts on, so all scenarios work on the new home. `DELETE /api/building` restores the sample.

The simulation is deterministic from (scenario, time, device), so any client can scrub time freely.
State is in memory: one server process is one demo.
