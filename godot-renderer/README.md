# godot-renderer

Godot 4.7 project that renders the floor, the SmartThings devices, the refrigerant piping and the
opened-device view with internal parts and live values.

Runs two ways:

| Target | Renderer | Used for |
|---|---|---|
| Desktop (Linux/Windows/macOS) | Forward+ (SSAO, glow, shadows) | Showcase build on a laptop |
| Web export, embedded in `web/` | GL Compatibility (WebGL 2), single-threaded | The product demo in the browser |

## Run

1. Install Godot 4.7.x (standard build, no .NET needed).
2. Start the web app first (`web/`, `npm run dev`) so `/api/floor` and `/api/devices/:id` are live.
   Without it the floor still renders, all devices show as healthy and parts show no values.
3. Open this folder in Godot and press F5, or: `godot --path godot-renderer`

`PLATFORM_URL` (env) overrides `http://localhost:3000` on desktop. On the web the page origin is used.

Controls: click a device to focus, double-click to open it, click a part to zoom to it,
P toggles piping, Esc goes back. Drag to orbit, right-drag to pan, wheel or pinch to zoom.

## Export to the web app

Install the web export templates once (`tools/install_web_templates.sh`, or Editor → Manage Export Templates), then:

```
godot --headless --path godot-renderer --export-release "Web"
```

This writes `web/public/godot/index.html` (+ .wasm/.pck/.js). Restart the web app (`next start` serves only files present at start).
The preset turns thread support off, so no COOP/COEP headers are needed.

## Structure

```
autoloads/bus.gd      signal hub; nothing else talks to anything directly
autoloads/store.gd    static data from data/*.json + live health/values polled from the platform
autoloads/bridge.gd   postMessage bridge with the host page (docs/contracts/bridge-api.md)
scripts/main.gd       builds the scene and routes Bus signals
scripts/floor_builder.gd   rooms, cut-away walls, labels, room status tint
scripts/device_node.gd     device body, health ring, highlight beam, click area
scripts/detail_view.gd     opened device: x-ray shell + exploded parts with live values + internal flows
scripts/tube.gd            shared pipe builder (floor piping and internal flows)
scripts/plan_geo.gd        room polygons, shared wall network, shortest path along walls
scripts/piping.gd          liquid/gas lines ODU → each AC, flow speed by health, trace
scripts/camera_rig.gd      orbit/pan/zoom, touch, fly_to
shaders/pipe_flow.gdshader animated refrigerant dashes (works on WebGL 2)
shaders/ghost.gdshader     fresnel x-ray shell
data/*.json                sample home (same files as web/lib/sim/data); used until the platform sends a layout
data/internal_flows.json   per device type: flows between parts, medium, and the live reading that sets the speed
data/part_layout.json      per device type: where each part sits inside the real unit (fractions of the body)
tools/install_web_templates.sh  installs only the web export templates
tests/smoke.gd             drives every bridge command; `godot --path . -- --smoke [--shot=out.png]`
tests/demo_shots.gd        screenshots of the upload flow against a running platform:
                           `godot --path . -- --demo-shots=/tmp/out --open=AC-03 --part=filter`
```

## Uploaded floor plans

`Store` polls `/api/floor`. When `layoutVersion` changes it loads `/api/building` and the plan image, then
`Bus.layout_changed` makes `main.gd` rebuild the world and play plan → 3D: the image lies on the floor,
rooms take colour, walls rise, devices drop in, piping appears, and the camera tilts from top-down.

## What is placeholder

Device bodies and parts are primitives (boxes and cylinders) so the pipeline works end to end.
Phase 3 and 4 of `docs/PROMPT.md` replace them with modelled parts (glTF), cut-away materials,
baked lighting and LODs. Keep part `key`s identical to `data/device_types.json`; the bridge,
the agent and the web panel all address parts by key.
