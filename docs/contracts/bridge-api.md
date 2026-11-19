# Bridge API: web page ↔ Godot renderer

The Godot web export runs in an iframe (`web/public/godot/index.html`). Messages use `window.postMessage`.
TypeScript types: `web/lib/bridge.ts`. Godot handler: `godot-renderer/autoloads/bridge.gd` (`Bridge.handle`).

## Host → renderer

Every message is `{ source: "twin-host", type, ...fields }`. The page queues messages until the renderer sends `ready`.

| type | fields | effect |
|---|---|---|
| `highlight` | `ids: string[]`, `reason?: string` | beam + pulsing ring on matches, others dimmed, camera frames them |
| `clearHighlight` | | undo highlight |
| `focusDevice` | `id` | camera flies to the device |
| `openDevice` | `id`, `part?` | x-ray shell, parts spread out with live values; focus `part` if given |
| `closeDevice` | | close and return to the floor view |
| `focusPart` | `id`, `part` | opens the device if needed, zooms to the part |
| `trace` | `from` (AC id) | brightens that AC's refrigerant circuit, dims the rest |
| `setLayer` | `layer: devices \| piping \| names \| ids \| temperature`, `on` | toggle a layer |
| `setTime` | `t` (hours, 6–22) | scene clock (sun, HUD, time-driven effects) |
| `setScenario` | `key: normal \| filter \| refrig \| washer` | closes any open device, refreshes flow |
| `resetView` | | close, clear, camera home |

## Renderer → host

Every message is `{ source: "twin-renderer", type, ...fields }`.

| type | fields | when |
|---|---|---|
| `ready` | `version` | first frame after the scene is built |
| `deviceClicked` | `id` | click on a device (drags are ignored) |
| `partClicked` | `id`, `part` | click on a part of an opened device |
| `deviceClosed` | | the open device was closed (Esc, back, scenario change) |

Layout changes (floor plan upload) do not go through the bridge: the renderer sees `layoutVersion` change in
`/api/floor`, loads `/api/building` and rebuilds. The page only refreshes its own lists.

## Rules

- Part keys are the `key`s in `data/device_types.json`. Device ids are the `id`s in `data/devices.json`.
- Unknown types are ignored with a warning, so the host can be newer than the renderer.
- Change this file in the same pull request as any change to the messages.
