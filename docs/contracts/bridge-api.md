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
| `setLayer` | `layer: devices \| piping \| names \| ids \| temperature \| exploded \| furniture \| comfort \| energy \| ops`, `on`, `metric?: thermal \| air \| score` | toggle a layer; `exploded` switches the open device between exploded and assembled (parts where they sit in the real unit); `comfort` draws the comfort field over each room's floor (colour by `metric`) with the room's score; `energy` draws power flowing from the distribution board to each room and a light pillar per device; `ops` (on by default for staff) shows beacons over devices that need attention or are predicted to fail, arrival auras and technician routes |
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
| `setQuality` | `tier: auto \| ultra \| high \| balanced \| lite` | rendering quality; `auto` (default) starts from the platform (mobile web lite, web balanced, desktop high) and follows the frame rate; `ultra` is Forward+ only (SDFGI, SSIL, SSR, volumetric fog) |
| `dispatchRoute` | `id` | a technician's route from the lift lobby (or the floor's entrance) to the device, with the technician walking it; reports `techRoute` |
| `welcome` | `room`, `guest?`, `state?: ready \| arrived` | the room's TV greets the guest by name and the room's lights pulse (also played automatically in a guest's view when their journey reaches ready / arrived) |
| `walk` | `action`: `start`, `stop`, `toggle`, `goto` (`room`), `stick` (`x`, `y` in −1..1), and for guests `skip`, `restart` (`from` room), `overview` (`on`), `look` (`id`: turn to a device), `show` (`id`: guided tour: walk to a spot in the room that sees the device, clear of walls and tall furniture, turn to it, then answer `viewing`), `live` (`on`: follow the live position) | first-person walk-through: `start` drops to eye height where the view is centred (or in `room`); walls reach the ceiling and rooms are entered through doorways; `goto` walks the route to a room; `stick` is the on-screen joystick (`y` −1 walks forward, `x` turns) |

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
| `quality` | `tier`, `auto`, `fps`, `scale`, `renderer: forward_plus \| compatibility` | the rendering tier now (on start and whenever auto changes it) |
| `techRoute` | `id`, `metres`, `from`, `phase: started \| arrived \| failed` | a technician's route was drawn, or the walking technician reached the device |
| `walk` | `on`, `room`, `roomName`, `note`, and for guests `guest: walking·arrived`, `from`, `to`, `metres`, `viewing` | walk-through started (`on: true`), entered another room, or ended (`on: false`); `note` when a room can't be reached; `viewing` (a device id) once a `show` has the device in sight, so the host opens its control only then |
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


## Guest 3D controls (renderer 0.5.0)

Host → renderer:

| Message | Meaning |
|---|---|
| `{type:'track', id}` | Report this device's screen position as `anchor` events (about every 80 ms while it changes); `id:''` stops. Also shows a turning ring of light around the device. |
| `{type:'preview', id, readings, text?}` | Show these readings on the device for 4 s (a control is being dragged), merged over the live state; `text` floats over the device. |

Renderer → host:

| Message | Meaning |
|---|---|
| `{type:'anchor', id, x, y, visible}` | Device position on the renderer viewport, `x`/`y` as 0–1 fractions; `visible` false when it is behind the camera or off screen. |

Device variants (see `DeviceNode.variant`): a device's `fixture` from the platform comes first: `spot` (a spot bulb
hanging from the zone's ceiling band), `wall` (a bulb in a wall socket), `lamp`, `desk`, `panel`, `window`, `roller`
(a roller curtain), `bespoke` (the coral Bespoke air purifier). `real: true` marks a device linked to a real
SmartThings device; it and every light, blinds and plug in the zone carry a live status badge. A room's `ceiling`
({band, drop, panels, diffusers, returns}: rectangles {x, z, w, d}) lays out its drop ceiling. Without a fixture,
by device name: "Ceiling AC…" is a ceiling cassette; lights named
"Floor lamp…"/"side lamp…" sit in a floor lamp, "Desk lamp" on the desk, "TV lamp"/"Main ceiling…" drive the
zone's LED ceiling panels, "…window" or "…window light" are back-lit window panes behind the nearest roller curtain; blinds named "…roller shade…" or
"…curtain…" are a roller curtain and "Projector screen…" a roller screen; "TV 65"…" is a TV on a stand.
Rooms with `finish: "st-zone"` get the SmartThings Experience Zone finish (panelling, tiles, drop ceiling).

## Experience data (platform → renderer)

Every `/api/floor` poll (and a guest's `/api/guest/<token>/floor`) carries `experience`, which the layers above draw:

| Key | Content |
|---|---|
| `comfort` | room → `{temp, hum, pm, lux, db, target, score, grade, sources: [{kind: cool\|warm\|clean\|daylight\|light\|noise, id, x, z, strength}]}` |
| `watts` | device id → watts now (measured or modelled) |
| `eco` | rooms the automation holds in eco |
| `journeys` | `[{room, state, guest, eta, readyAt}]` (a guest gets only their own) |
| `predictions` | staff only: `[{id, part, when, etaMin, title}]` |
| `dispatches` | staff only: `[{id, from, status}]` |

