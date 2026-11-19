# Build prompt: Agentic Digital Twin Map View (Godot 4 + AI agent + Next.js)

Copy everything below this line into your AI coding agent, or give it to the development team as the project brief.
Repository: https://github.com/ShawonNSTU/AgenticDigitalTwinMapview (a working scaffold of all three parts is already there).

---

## 1. Your role

You are a senior engineer on a 5–6 person team. You will build a polished proof of concept (PoC) that shows a managing director what the team can do in real-time 3D rendering, live data visualisation and AI agents for device operations.

The PoC has three parts, each in its own top-level folder of one repository:

| Folder | Stack | Owns |
| --- | --- | --- |
| `godot-renderer/` | Godot 4.7.x stable, GDScript | Everything 3D: floor, devices, piping, opened-device internals, shaders, camera, 4D time effects |
| `agent-backend/` | Python 3.11+, FastAPI, Anthropic Claude API (tool use) | The AI agent: natural-language device search, device insights, device control, and map actions (highlight, focus, open, trace) |
| `web/` | Next.js (App Router, TypeScript) | The product UI around the 3D view (side panel, chat, timeline) and the simulated device platform API that both other parts read |

Work in phases (section 17). At the end of each phase: run all three parts together, fix every error and warning, take screenshots of the views you changed, and write a short report of what works, what doesn't, and what is next. Never leave `main` in a state that does not run.

## 2. What the PoC must demonstrate

Three features, in this order. Everything else in this brief serves them.

1. **Floor plan to 3D map.** The user uploads a floor plan image. AI vision proposes the rooms, the user corrects them, places SmartThings devices (or auto-places typical ones per room), and the plan turns into a 3D map view with every device where it is installed.
2. **Device digital twin.** Clicking any device opens it in place on the map into a digital twin of its internal components, with the internal flows (refrigerant, air, water, drain, power, signal), the piping that connects it to the rest of the system, and real-time readings and health on every part.
3. **AI agent.** In plain language the user can search devices and get them highlighted on the map, get insights about a device (what is wrong, the evidence, what to do), and control devices, with confirmation for risky commands.

A floor of a building (a home in the demo) shown as a live 3D map. Every smart device is placed where it is installed. The air-conditioning piping is drawn and animated. Clicking any device opens it **in place on the map** into its internal components, each showing live readings and health. A rule engine diagnoses faults, traces system-wide faults through the pipes, and guides the technician step by step. An AI agent answers questions in plain language and drives the map: it finds devices and lights them up, explains faults by opening the device at the right part, and sends device commands after the user confirms.

The story the guided tour must tell, in order:

1. Upload a 2D floor plan image; AI detects the rooms; the presenter fixes one room name and auto-places devices.
2. The plan turns into a 3D map view: the image fades back, rooms get colour, walls rise, furniture appears.
3. All smart devices drop onto the map as pins.
4. The AC piping layer appears with live refrigerant flow.
5. A device turns red on the map (live health).
6. The device opens in place into its internal parts with live readings, and its internal flows run between the parts (for an AC: refrigerant through the coil, air through filter, coil, fan and louver, condensate to the drain, power and signals from the control board).
7. Guided troubleshooting moves the camera to each part, step by step.
8. The fix is applied and the readings visibly recover.
9. A system-wide fault: the trace runs through the pipes from the affected rooms back to the outdoor unit.
10. The outdoor unit opens in place and confirms the cause.
11. A non-HVAC case: a water leak sensor connects to the washer's drain pump fault.
12. Preventive maintenance: a low sensor battery.
13. The agent: the presenter types "show every air conditioner with a problem", the matches light up; then "why is the kitchen warm?", the agent opens the right unit at the right part and explains the evidence; then "set the bedroom AC to 24 degrees", the command runs and the reading changes on the map; then "unlock the front door", the agent asks for confirmation first.
14. Free exploration.

## 3. Hard constraints

- **Godot:** 4.7.x stable, typed GDScript, `class_name` where useful, signals for decoupling (all cross-feature traffic goes through the `Bus` autoload). A GDExtension (C++) only for a measured performance need, documented.
- **Renderers:**
  - **Desktop showcase build:** Forward+ (Vulkan / Direct3D 12 / Metal). Used to show the full rendering feature set.
  - **Web build:** Compatibility renderer (WebGL 2), single-threaded export (no COOP/COEP headers needed), embedded in the Next.js page in an iframe. This is the build the product demo runs on. Every Forward+ feature needs a lower-quality fallback.
- **One source of truth for data:** the simulated device platform lives in `web/` (Next.js Route Handlers under `/api`). Godot, the agent and the web UI all read it; none of them keeps its own copy of the simulation. Readings are deterministic from (scenario, time, device) so scrubbing works anywhere.
- **Agent safety:** the agent may only call whitelisted commands. Risky commands (unlock, stopping a running appliance) are rejected by the platform unless `confirmed=true`, and the agent may set that only after the user says yes to that exact action in their latest message. Every claim the agent makes must come from a tool result. The agent never invents device ids or readings.
- **Data:** all simulated. No real device APIs. The adapter that reads the platform is isolated in each part so a real platform could replace the simulator later.
- **Branding:** no Samsung, SmartThings or other company logos, product names or UI imitation. Use a neutral product name such as "Diagnostic Twin". Device names are generic. The UI shows "Prototype · simulated data" at all times.
- **Assets:** only our own, or permissive licences (CC0 such as Poly Haven or Kenney, or MIT). Keep `CREDITS.md`.
- **Secrets:** the Anthropic API key lives only in `agent-backend/.env`. The browser never sees it; it talks to the agent through the Next.js `/api/chat` proxy.
- **Performance targets:** desktop 60 fps at 1440p (RTX 3060-class or Apple M-series) with all effects on; web build 30 fps on a mid-range laptop; agent first token under 2 s, a full search-and-highlight answer under 5 s.

## 4. Repository layout and how the parts talk

```
AgenticDigitalTwinMapview/
  agent-backend/          FastAPI + Claude tool-use loop
    app/main.py           POST /chat (SSE), GET /search, GET /health
    app/agent.py          system prompt, tool loop, demo mode without an API key
    app/tools.py          tool schemas + executors; each returns (result, ui events)
    app/search.py         deterministic NL search (synonyms for types, rooms, health, ids)
    app/platform.py       HTTP client for the web app's /api
    tests/                pytest: search, tools, demo mode
  godot-renderer/         Godot 4.7 project
    autoloads/            Bus (signals), Store (data + polling), Bridge (postMessage)
    scripts/              main, floor_builder, device_node, detail_view, piping, camera_rig
    shaders/              pipe_flow, ghost (+ the rest of section 7)
    data/                 building.json, devices.json, device_types.json
    tests/smoke.gd        drives every bridge command, optional screenshot
    export_presets.cfg    Web → ../web/public/godot/, Linux, Windows
  web/                    Next.js
    app/api/...           simulated device platform (section 9) + /api/chat proxy
    lib/sim/              engine.ts (simulator, rules, findings), runtime.ts (clock, commands)
    lib/bridge.ts         typed postMessage bridge to the Godot iframe
    components/           TwinView, DevicePanel, ChatPanel, Timeline
    public/godot/         Godot web export output
  docs/
    contracts/bridge-api.md     host ↔ renderer messages
    contracts/platform-api.md   REST + SSE of the simulated platform
    contracts/agent-api.md      /chat event stream
    PROMPT.md                   this brief
```

```
Browser ── Next.js page ──postMessage──▶ Godot web build (iframe)
   │            ▲   ◀──events (deviceClicked, partClicked)──┘
   │            │                         │
   │        SSE /api/events               │ HTTP polling /api/floor, /api/devices/:id
   │            │                         ▼
   │      Next.js Route Handlers  =  simulated device platform
   │            ▲
   └─/api/chat──┼──▶ agent-backend /chat (SSE) ── tools ──HTTP──▶ platform
                │        └─ ui_action events ──▶ page ──▶ Godot bridge
```

**Rule for map actions:** the agent never talks to Godot directly. It emits `ui_action` events in its SSE stream; the page forwards them to the renderer with `lib/bridge.ts`. The same message types are used by the side panel, so anything the agent can do, a click can do too.

## 4a. Floor plan upload (web/app/setup, agent-backend/app/floorplan.py)

1. **Upload:** PNG, JPEG or WebP. The browser downscales to at most 2000 px and sends a data URL.
2. **Detect rooms:** `POST /api/floorplan/parse` → agent `POST /floorplan/parse`. Claude vision returns axis-aligned room rectangles in 0..1 image coordinates plus an optional outdoor point. Clean and clamp the result; never trust it blindly. Without an API key, explain and fall back to drawing.
3. **Review:** rooms are drawn over the image; the user renames, deletes or redraws (drag to draw). L-shaped rooms are two rectangles with the same name.
4. **Devices:** auto-place typical devices from room names (kitchen → AC, light, fridge, oven; laundry → washer, dryer, leak sensor; and so on) plus one outdoor unit outside the plan, or place by hand from a type list. Ids follow the type prefix (AC-01, LT-01, ODU-01).
5. **Scale:** the user enters the real width of the plan in metres. Image fractions map to metres with the origin at the image centre.
6. **Build:** `POST /api/building` replaces the layout in the platform. The simulator picks the devices each scenario acts on from the new layout (bedroom AC for blocked airflow, the two ACs farthest from the outdoor unit for the refrigerant leak, the leak sensor nearest the washer), so every scenario works on any plan.
7. **Render:** the platform bumps `layoutVersion`; Godot sees it in `/api/floor`, loads `/api/building` and the plan image, rebuilds the scene and plays the plan-to-3D animation. The web page gets a `layout` SSE event and refreshes its lists.
8. Later phases: walls and door gaps traced from the image (not only room rectangles), non-rectangular rooms, multiple floors, and importing real device lists instead of placing them.

## 5. Visual direction

- Clean, bright "map view" look: each room has its own pastel floor colour, furniture is tinted in a darker shade of the room colour, and walls are frosted white and cut low (about 1.1 m) so you can see into every room.
- Device pins: white rounded markers with a dark line icon, floating above each device, with a small health dot (amber = watch, red = fault, pulsing).
- Soft daylight, soft shadows, ambient occlusion and gentle bloom. Light and dark UI themes.
- Typography: one clean sans-serif (for example Inter, OFL licence). Sentence case everywhere.

## 6. Scene content

### 6.1 Floor layout (home, about 20 m × 12 m)

| Room | Rough extent (x, z in metres, origin at centre) | Floor colour |
| --- | --- | --- |
| Media room | x −10…−5, z −6…−0.5 | light blue |
| Living room | x −5…1, z −4.4…2 | light green |
| Deck | x −3.2…0, z −6…−4.4 | lavender |
| Kitchen | x 1…5, z −6…1.5 | light yellow |
| Primary suite | x 5…10, z −6…1.5 | aqua |
| Bedroom | x −10…−5, z −0.5…6 | pink |
| Porch | x −5…−2, z 2…6 | pale green |
| Dining room | x −2…3, z 2…6 | sky blue |
| Laundry room | x 3…5.5, z 1.5…6 | blue |
| Bathroom | x 5.5…10, z 1.5…6 | mint |

The outdoor AC unit stands on a pad outside the back wall, at about (−4.2, 0, −7.3).

### 6.2 Devices (about 38)

| Type | Count | Mount |
| --- | --- | --- |
| Air conditioner, wall-mounted indoor unit | 6 (media, living, kitchen, primary, bedroom, dining) | wall, 2.15 m |
| AC outdoor unit | 1 | ground, outside |
| Smart light | 8 | ceiling |
| TV | 2 | wall |
| Speaker | 2 | furniture |
| Smart blinds | 3 | exterior windows |
| Refrigerator, oven | 1 each | kitchen |
| Robot vacuum | 1 | floor |
| Camera (indoor, outdoor) | 2 | wall |
| Video doorbell, door lock | 1 each | porch door |
| Washer, dryer | 1 each | laundry |
| Water leak sensor | 2 (laundry, bathroom) | floor |
| Temperature and humidity sensor | 1 | bathroom wall |
| Motion sensor | 2 | wall corner |
| Smart plug | 1 | wall |
| Air purifier | 1 | floor |

### 6.3 Internal components per device type

Every device type must open into its own parts. Each part has a name, a live reading, a health rule, and a history series for charting.

| Type | Parts |
| --- | --- |
| AC indoor unit | front panel, air filter (no sensor, inferred), evaporator coil, cross-flow fan, fan motor, louver motor, drain pan and hose, coil temp sensor, room temp sensor, control board, Wi-Fi module |
| AC outdoor unit | compressor, accumulator, 4-way valve, expansion valves, high-pressure sensor, low-pressure sensor, outdoor coil, fan, inverter board |
| Light | LED board, LED driver, diffuser, radio |
| TV | display panel, main board, power supply, Wi-Fi |
| Speaker | driver, amplifier, mic array, Wi-Fi |
| Blinds | tube motor, battery pack, radio |
| Refrigerator | compressor, condenser coil, evaporator, fridge sensor, freezer sensor, door switch |
| Oven | heating element, cavity temp sensor, convection fan, control board |
| Robot vacuum | battery, brush motor, lidar, dust bin |
| Camera, doorbell | image sensor or camera module, IR LEDs or button, mic, battery, Wi-Fi |
| Door lock | bolt motor, keypad, battery, radio |
| Washer | drain pump, water level sensor, drum motor, inlet valve, door lock, control board |
| Dryer | heater, drum motor, lint filter, exhaust temp sensor |
| Leak sensor | water probes, battery, radio |
| Temp/humidity sensor | temperature sensor, humidity sensor, battery, radio |
| Motion sensor | PIR sensor, Fresnel lens, battery, radio |
| Smart plug | relay, power meter, radio |
| Air purifier | HEPA filter, fan, PM2.5 sensor, control board |

The AC indoor unit and outdoor unit get hand-built, detailed part models (finned coil, bladed fan, capsule compressor, valve bodies, circuit boards). All other types may use simpler procedural parts, but each must look distinct and readable.

## 7. Rendering showcase: required techniques (godot-renderer)

This is the core of the PoC. Each item must be visible during the tour and listed in an in-app "Rendering features" panel that can be toggled on and off live for comparison.

### 7.1 Lighting and image quality (Forward+)

1. `WorldEnvironment` with a `PhysicalSkyMaterial` driven by a sun `DirectionalLight3D`. A time-of-day slider moves the sun and changes sky, light colour and shadow direction.
2. Global illumination:
   - **Default:** baked `LightmapGI` for the static house (walls, floors, furniture).
   - **Comparison:** an `SDFGI` mode for dynamic time of day, with a toggle between the two.
   - **Interiors:** `ReflectionProbe` nodes for glossy appliance surfaces.
3. SSAO, SSIL, glow/bloom, filmic or AgX tonemapping, TAA or FSR 2, and `VolumetricFog` for soft light shafts through the windows at sunset.
4. Soft directional shadows with tuned cascades. Contact shadows under devices.
5. Light devices are real `OmniLight3D` or `SpotLight3D` lights whose energy follows the device's live dim level.

### 7.2 Custom shaders (Godot shading language)

1. **Room data overlay:** a floor shader that tints each room by live temperature or energy. Read the values from a small data texture (one texel per room), not from per-room material changes.
2. **X-ray / ghost shader:** when a device opens, its outer shell fades to a fresnel-edged glass look and its internal parts stay solid.
3. **Section plane:** a clip plane that slices walls and ceilings, with solid capped cut faces (stencil or back-face technique), used to reveal ceiling pipes.
4. **Pipe flow:** pipes coloured by refrigerant state (liquid amber, low-pressure gas blue, high-pressure gas red, idle grey), with animated flow as scrolling UV bands inside the pipe shader. Speed and direction come from live data.
5. **Trace pulse:** a travelling light pulse along the traced pipe path, from the faulty rooms back to the outdoor unit.
6. **Health highlight:** an emission/outline pass on faulty parts (fresnel rim or inverted-hull outline), pulsing for faults.
7. **Thermal camera mode:** a full-screen post effect mapping surface temperature to an infrared palette, implemented as a `CompositorEffect` (desktop) with a simple material-based fallback for the web build.
8. **Build-up animation:** walls grow from the floor plan using a vertex shader driven by one `build_progress` uniform; furniture fades and scales in after.

### 7.3 GPU and scale techniques

1. `MultiMeshInstance3D` for repeated geometry (pipe joints, flow particles, furniture repeats).
2. `GPUParticles3D` for flow particles close up and for air leaving the AC louvers (blue when cooling, orange when heating).
3. **Optional, desktop only:** a compute shader through `RenderingDevice` that updates flow particle positions along pipe paths. Keep a `GPUParticles3D` fallback.
4. **Level of detail:** visibility ranges (HLOD) on devices and furniture, and occluders on solid walls.
5. **Scale test:** a hidden key duplicates the floor 20 times (a building or estate) and shows live counters for frame time, draw calls and object count. It must stay above 60 fps on desktop.

### 7.4 Procedural geometry

1. Generate walls, floors and door gaps from a `building.json` floor description using `SurfaceTool` / `ArrayMesh` (not hand-placed meshes).
2. Generate the refrigerant pipe network (trunk plus branches to each AC) from the device list: route up from the outdoor unit, along a ceiling trunk, and drop to each unit. Build tubes with proper bends and joint spheres.
3. Generate the 2D floor plan image at runtime from the same `building.json` into a `SubViewport` texture (walls, door gaps, room names, areas, grid), used for tour step 1.

### 7.5 4D (time) rendering

1. Fetch 16 hours of history (06:00–22:00) per part from `GET /api/devices/:id/history?part=` and cache it.
2. Pack room and device values into data textures (rows = entities, columns = minutes) so shaders sample by time. Scrubbing the timeline must be smooth at any speed.
3. Light, data overlays, pipe flow and part readings all follow one shared scene clock.

## 8. Interaction design

### 8.1 Map view

- Orbit, pan and zoom camera with smooth damping and limits. Double-click a room to fly to it.
- Layer toggles: devices, AC piping, room names, device IDs, temperature overlay.
- Pins are screen-space `Control` nodes projected from 3D each frame, clickable, and hidden when behind the camera. Health dot and pulsing state are shown on the pin. Show labels only for selected and unhealthy devices, to avoid clutter.

### 8.2 Opening a device in place

1. The camera flies (eased Tween, about 1.3 s) to a framing chosen by device size and mount: from below for ceiling and wall units, from above for floor devices.
2. All other devices are hidden. A distance fog (or depth-based desaturation) pushes the room into the background.
3. The shell goes to the ghost shader. Parts animate from their assembled positions to exploded positions. An explode/assemble toggle is available.
4. Each part gets a floating label: name, live value, health colour. Clicking a part focuses the camera on it and charts its history.
5. **Internal flows** (`godot-renderer/data/internal_flows.json`): each type lists flows between part keys, or between a part and `@body` (the device's own pipe or cable connection), with a medium: refrigerant liquid/gas, air, water, drain, power, signal, heat, light. Draw them as curved tubes with the flow shader. Speed and colour follow the health of the parts at both ends: normal flows, watch slows, fault stops and turns red. Show a legend of the media in view. While a device is open, other devices and the floor piping are hidden.
6. Fans spin at their live speed. The AC louver opens to its live angle. The filter texture gets visibly dirtier as airflow drops. The coil turns frosty white below 3 °C.

### 8.3 Side panel and chat (web/)

The side panel and chat are React components in `web/`, not Godot UI, so they look like a product and stay crisp at any zoom. The desktop showcase build keeps a compact in-engine panel (finding, steps, part list) fed by the same API.

**No device selected:** tabs for Agent (chat) and Devices (list with health dots; hovering a row highlights the device on the map). Floor summary in the header.

**Device selected:**
- Header with ID, type, room and health badge; "Open in place" and "Back to floor".
- Finding card: title, confidence ("Confirmed by sensor", "Likely", or "Inferred"), evidence list with live values, guided steps.
- Parts list with live values and health dots; clicking a part sends `focusPart` to the renderer.
- History chart of the selected part with a cursor at the current time and a shaded band after fault onset.

**Chat:** streaming answer text, a small grey line per tool call ("search_devices: 2 matches"), and a confirmation card with Yes / No buttons when the agent asks to confirm a risky command.

### 8.4 Guided troubleshooting

- Each finding has 3–5 steps. Each step names a part.
- The current step focuses the camera on that part and highlights it.
- Buttons: Previous, "Done, next step", and "Mark as fixed" on the last step. Some steps link to another device (for example "Open WA-01").
- "Mark as fixed" sets a fix time. Readings recover over 30 simulated minutes while the timeline plays.

### 8.5 Timeline

Play/pause, a scrub slider from 06:00 to 22:00, a fault-onset marker, and speed control.

### 8.6 Guided tour

- Fourteen steps (section 2), each with a title, two to three sentences of plain-language text, and a scripted state: scenario, time, layers, selection, opened device, camera shot.
- Next, Back and Exit buttons. A caption card in a top corner.
- Each step must be reachable directly from Back/Next without breaking state.

## 9. Simulated device platform (web/app/api)

Next.js Route Handlers (`dynamic = 'force-dynamic'`), state kept on `globalThis` so it survives hot reload. One process is one demo.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/floor` | rooms, all devices with position, type, room and health, current time |
| `GET /api/devices?type=&room=&health=` | plain filtering |
| `GET /api/devices/:id` | live snapshot: readings, parts (key, name, value, health, inferred), finding |
| `GET /api/devices/:id/history?part=` | `{unit, now, points: [[hour, value]...]}` for 06:00–22:00 |
| `GET/POST /api/devices/:id/commands` | list / run whitelisted commands; 409 when confirmation is needed |
| `GET/POST /api/sim` | scenario, clock, play/pause, speed, "mark as fixed" |
| `GET /api/events` | SSE: `clock` every 500 ms, `health` when any device changes, `layout` after an upload |
| `GET/POST/DELETE /api/building` | current layout / replace it with an uploaded plan, rooms and devices / back to the sample home |
| `GET /api/building/plan` | the uploaded plan image |
| `POST /api/floorplan/parse` | proxy to the agent's room detection |
| `POST /api/chat` | proxy to `agent-backend` `/chat`, streams SSE back |

Health levels: ok, watch, fault. A device's health is the worst of its parts. Inferred findings are labelled as inferred. Commands override readings on top of the simulation (for example AC set point), so the agent's actions are visible on the map.

**Scenarios (each with a fault onset time and a ramp):**

| Scenario | Affected | Symptoms and rule |
| --- | --- | --- |
| Normal | none | all within range |
| Blocked airflow | Bedroom AC | airflow down to about 45 %, fan up to 100 %, coil inlet near 1 °C, room 3.5 °C above set point → filter fault (inferred), fan and coil watch |
| Refrigerant shortage | whole AC system, strongest at the two units farthest from the outdoor unit | outdoor discharge temp rises above 100 °C, low pressure falls below 7.5, expansion valves near fully open, far rooms warm → likely leak; trace from far units to outdoor unit |
| Washer drain fault | washer, laundry leak sensor | pump current 0 A, water level high, drain error; leak sensor wet 15 min later → confirmed by sensor; cross-device link |
| Always on | Primary suite motion sensor | battery 12 % → watch |

**Health levels:** normal, watch, fault. A device's health is the worst of its parts. Inferred findings must be labelled as inferred.

## 10. AI agent (agent-backend/)

**Model and loop.** Anthropic Messages API with tool use, model from `AGENT_MODEL` (default `claude-sonnet-5-5`). Loop up to 8 tool rounds per user turn. Stream SSE events to the client: `text`, `tool` (name + one-line summary), `ui_action` (a bridge message), `select` (open a device in the side panel), `error`, `done`.

**Tools.**

| Tool | Does | UI effect |
| --- | --- | --- |
| `search_devices(query, type?, room?, health?, highlight=true)` | deterministic NL search over the floor | highlight matches |
| `get_floor_summary()` | rooms, counts by type, unhealthy devices with finding titles | none |
| `get_device_insights(device_id)` | parts, readings, finding, supported commands | none |
| `get_part_history(device_id, part)` | start, now, min, max, when it changed most | none |
| `control_device(device_id, command, args, confirmed=false)` | runs a whitelisted command | highlight the device |
| `show_on_map(action, device_ids, part?)` | highlight, focus, open (+part), trace, clear, reset | the matching bridge message |
| `set_map_view(layer?, on?, scenario?, time?)` | layers, scenario, clock | `setLayer`, platform clock |

**Search is deterministic on purpose.** The model decides what to look for; `app/search.py` decides which ids match (type and room synonyms, health words, explicit ids such as "AC-05", "bedroom" not matching "primary suite"). This keeps highlights honest and testable. Extend it with an embedding index only if the synonym table stops being enough.

**Behaviour rules (system prompt).** Ground every claim in a tool result. To explain a fault: insights → open the device at the most relevant part → evidence and the first guided step. Use trace for refrigerant faults. For commands that need confirmation: ask in one sentence and stop. Answers two to five sentences, ids like AC-04, times as HH:MM.

**Demo mode.** With no `ANTHROPIC_API_KEY`, a rule-based path still searches, highlights and explains a single device from its finding, so the demo never depends on network access to the model.

**Evaluation.** Keep `agent-backend/evals/cases.yaml` with 30+ prompts and expected tool calls / highlighted ids (for example "which ACs have a problem" → AC-04, AC-05 in the refrigerant scenario at 15:00). Run it in CI against demo mode, and nightly against the real model. Track pass rate and latency.

## 11. Godot ↔ web bridge (contract: docs/contracts/bridge-api.md)

Host → renderer: `window.postMessage({source: "twin-host", type, ...})` with types `highlight`, `clearHighlight`, `focusDevice`, `openDevice`, `closeDevice`, `focusPart`, `trace`, `setLayer`, `setTime`, `setScenario`, `resetView`.

Renderer → host: `parent.postMessage({source: "twin-renderer", type, ...})` with `ready`, `deviceClicked`, `partClicked`, `deviceClosed`.

The page queues messages until `ready`. `Bridge.handle()` in Godot is also the entry point for `tests/smoke.gd`, so every message type is covered by a headless test.

## 12. UI and UX quality bar

- A custom Godot `Theme` with light and dark variants, consistent spacing, 8 px radius, and readable 13–15 px text.
- Every interactive element has hover and pressed states.
- Window layout:
  - **16:9 and wider:** side panel at 340–360 px.
  - **Narrow windows:** the side panel moves to the bottom.
- All text in plain language. No raw codes or jargon without a short explanation. Fault codes are marked "(mock code)".

## 13. Rendering-features panel (for the MD)

A collapsible panel listing every technique in section 7 with an on/off toggle and a one-line description, plus a live performance overlay (fps, frame time, draw calls, primitives). This lets the presenter show the difference each technique makes.

## 14. Export, run and delivery

1. **Local run:** `web` (`npm run dev`, port 3000), `agent-backend` (`uvicorn app.main:app --port 8000`), then open http://localhost:3000. Godot desktop builds read the same platform at `PLATFORM_URL`.
2. **Web build:** `godot --headless --path godot-renderer --export-release "Web"` writes to `web/public/godot/`. Downgrade automatically: lightmaps on, SDFGI off, volumetric fog off, compositor effects replaced by material fallbacks, fewer particles. Show "Web preview: reduced effects".
3. **Desktop builds:** Windows and macOS, Forward+, release templates.
4. **Deploy (optional):** web on any Node host, agent as a container; set `AGENT_URL` in web and `PLATFORM_URL` + `ANTHROPIC_API_KEY` in the agent.
5. **CI (GitHub Actions):** web typecheck and build; agent pytest + eval in demo mode; Godot headless import + `--smoke`.
6. A 3–4 minute screen recording of the full tour at 1440p as a fallback for the meeting.
7. README per folder and at the root: how to run, feature list mapped to tour steps, known limitations, how to swap the simulator for a real platform.

## 15. Acceptance criteria

1. The tour runs from step 1 to 14 and back without errors or broken state.
1a. Uploading a new floor plan (AI detection or hand-drawn rooms) and rendering it works end to end in under a minute, and all four scenarios produce findings on the new layout.
1b. Every device type shows its internal flows when opened, and the flows react to live part health.
2. Every one of the 38 devices can be opened in place and shows parts with live values that change with the timeline.
3. All four scenarios produce the specified findings. "Mark as fixed" makes readings recover.
4. The trace pulse follows the correct pipe path to the outdoor unit.
5. Each rendering technique in section 7 is visible and can be toggled in the features panel.
6. The agent passes the eval set (90 %+ in demo mode for search cases, 85 %+ with the model overall), never runs a confirm-required command without a yes, and every highlight it makes matches its answer.
7. Desktop: steady 60 fps at 1440p with all effects on. Scale test above 60 fps. Web: 30 fps.
8. No console errors in any of the three parts. `CREDITS.md` complete. No third-party brands.

## 16. Engineering rules

- Contracts first: change `docs/contracts/*` in the same pull request as the code that changes a message or endpoint.
- Godot: small composable scenes, one responsibility per script, no per-frame allocations in hot loops, data-driven device types (adding a type needs only a type definition, except the two hand-built AC models), signals over node paths.
- Web: server components for static parts, client components only where state lives; no secrets in the client bundle.
- Agent: tools are pure functions of (args, platform); each returns its UI events instead of calling the UI. Unit-test every tool with a fake platform.
- Profile Godot with the profiler and visual profiler at the end of each phase; record the numbers in the phase report.

## 17. Phases and team split

Suggested split for 5–6 people: two on Godot rendering, one on Godot interaction and bridge, one on Next.js and the platform, one on the agent, one shared on tour, QA and delivery.

| Phase | Godot | Agent | Web | Done when |
| --- | --- | --- | --- | --- |
| 1. Foundations (scaffold exists) | autoloads, data, camera, floor, device bodies, piping, open-in-place with primitives and internal flows, uploaded layouts with plan-to-3D animation | tools, search, demo mode, room detection, tests | platform API, plan upload editor, bridge, panel, chat, timeline | All three run together; smoke test and pytest pass |
| 2. Floor | procedural walls with door gaps, 2D plan texture, build-up shader, furniture, lighting | floor summary wording | Devices tab, header summary | Tour steps 1–2 look finished |
| 3. Devices and pins | screen-space pins with icons and health, layers | search eval set v1 | hover highlight, layer toggles | Step 3 works; agent search lights up pins |
| 4. Piping | network with bends and joints, flow particles, trace pulse | trace in explanations | — | Steps 4 and 9 work |
| 5. Open in place | hand-built AC indoor/outdoor models, explode, part labels, focus camera | open at the right part | part history chart | Any device opens with live parts |
| 6. Rules and guide | step focus, recover animation | confirmation flow, control commands | confirmation card, Mark as fixed | Scenarios, battery case and commands work |
| 7. Rendering showcase | GI options, fog, section plane, thermal mode, room overlay, features panel, scale test | — | features panel toggles via bridge | Every section 7 item toggles live |
| 8. Tour and polish | transitions, web fallbacks, performance | latency, eval pass rate | 14-step tour, themes, responsive | Acceptance criteria pass |
| 9. Delivery | desktop and web exports | container | deploy, recording | All section 14 items exist |

## 18. Start now

1. Clone the repository and run all three parts (root README). Read `docs/contracts/`.
2. Restate the plan in 10 bullet points and list any decisions you need from me. Otherwise choose sensible defaults and note them.
3. Begin Phase 2 (Phase 1 scaffold is in place; fix anything in it that does not meet this brief first).
