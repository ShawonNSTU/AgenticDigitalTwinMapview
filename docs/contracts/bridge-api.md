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
| `setLayer` | `layer: devices \| piping \| names \| ids \| temperature \| exploded \| furniture`, `on` | toggle a layer; `exploded` switches the open device between exploded and assembled (parts where they sit in the real unit) |
| `setTime` | `t` (hours, 6–22) | scene clock (sun, HUD, time-driven effects) |
| `setScenario` | `key: normal \| filter \| refrig \| washer` | closes any open device, refreshes flow |
| `resetView` | | close, clear, camera home |
| `camera` | `action`: `zoomIn`, `zoomOut`, `fit`, `top`, `perspective`, `toggleTop`, `rotateLeft`, `rotateRight`, `tiltUp`, `tiltDown`, `reset` | navigation: zoom, fit the whole floor, plan view, turn 45°, tilt 12° |
| `setInsets` | `left`, `right`, `top`, `bottom` (px) | screen space covered by the page's overlays; fits keep the floor clear of them and re-fit until the user moves the view |
| `dragStart` | `deviceType` | a palette tile is dragged over the map: a see-through device follows the pointer |
| `dragMove` | `u`, `v` (pointer, 0–1 across the map) | the device snaps where that type is installed (wall, door, ceiling, floor); the room is outlined green, or red if it can't go there |
| `dragEnd` | `u`, `v`, `drop` | `drop: true` reports `dropDevice`; `false` cancels |
| `startMove` | `id` | the placed device follows the pointer inside the map; click puts it down (`moveDevice`), right-click or Esc cancels |
| `refreshDevices` | | poll the platform now (the page just added, moved or removed a device) |
| `selectRoom` | `room` | highlight a room's floor (`""` clears) |
| `walk` | `action`: `start`, `stop`, `toggle`, `goto` (`room`), `stick` (`x`, `y` in −1..1), and for guests `skip`, `restart` (`from` room), `overview` (`on`), `look` (`id`: turn to a device), `live` (`on`: follow the live position) | first-person walk-through: `start` drops to eye height where the view is centred (or in `room`); walls reach the ceiling and rooms are entered through doorways; `goto` walks the route to a room; `stick` is the on-screen joystick (`y` −1 walks forward, `x` turns) |

## Renderer → host

Every message is `{ source: "twin-renderer", type, ...fields }`.

| type | fields | when |
|---|---|---|
| `ready` | `version`, `view: [w, h]` | first frame after the engine starts |
| `floorBuilt` | `rooms`, `devices` | a floor (layout) has been built and is on screen |
| `viewport` | `view: [w, h]` | the canvas was resized |
| `camera` | `yaw`, `pitch` (degrees), `distance` (m), `top` | the view changed (at most 4 per second) |
| `deviceClicked` | `id` | click on a device (drags are ignored) |
| `partClicked` | `id`, `part` | click on a part of an opened device |
| `deviceClosed` | | the open device was closed (Esc, back, scenario change) |
| `roomClicked` | `room`, `roomName` | a click on a room's floor in the map view |
| `guestDenied` | `code` | the guest link stopped working (404/410) |
| `walk` | `on`, `room`, `roomName`, `note`, and for guests `guest: walking·arrived`, `from`, `to`, `metres` | walk-through started (`on: true`), entered another room, or ended (`on: false`); `note` when a room can't be reached |
| `placeHover` | `room`, `roomName`, `valid`, `mount` | while dragging: the room under the pointer and how the device would be mounted |
| `dropDevice` | `deviceType`, `x`, `y`, `z`, `rotationY`, `room` | a device was dropped; the page adds it with `POST /api/devices` |
| `moveDevice` | `id`, `x`, `y`, `z`, `rotationY`, `room` | a placed device was put down somewhere else; the page saves it with `PATCH /api/devices/:id` |

Layout changes (floor plan upload) do not go through the bridge: the renderer sees `layoutVersion` change in
`/api/floor`, loads `/api/building` and rebuilds. Device changes (placed, moved, removed) bump `devicesVersion`
instead: the renderer reloads only the devices and their piping, and new or moved devices drop into place.
The page only refreshes its own lists.

## Device placement API (platform)

| request | body | result |
|---|---|---|
| `POST /api/devices` | `type`, `x`, `z`, `y?`, `rotationY?`, `room?`, `name?` | 201 with the device (`id` like `AC-01`; mount height from the type unless `y` is given) |
| `PATCH /api/devices/:id` | `x?`, `z?`, `y?`, `rotationY?` | the moved device (room recomputed) |
| `DELETE /api/devices/:id` | | `{ ok: true }` |

## Rules

- Part keys are the `key`s in `data/device_types.json`. Device ids are the `id`s in `data/devices.json`.
- Unknown types are ignored with a warning, so the host can be newer than the renderer.
- Change this file in the same pull request as any change to the messages.

Guest mode: the page loads the renderer as `/godot/index.html?guest=<token>`. The renderer then reads only
`/api/guest/<token>/building` and `/floor`, starts the walk from the entrance to the guest's room by itself, opens
only the rooms on the way, and keeps the guest in the room once there. Map navigation, device placement and the
internal twin are off for guests.
