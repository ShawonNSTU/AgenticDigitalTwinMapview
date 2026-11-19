# Platform API: simulated device platform (web/app/api)

Base URL: the Next.js app (`http://localhost:3000` in development). All responses are JSON unless noted.
Time `t` is in hours (6.0 to 22.0). Health is `ok`, `watch` or `fault`.

## GET /api/floor
`{ time, scenario, layoutVersion, rooms: [{key, name, x:[x0,x1], z:[z0,z1], poly?: [[x,z]...], color}], devices: [{id, type, label, room, name, position:[x,y,z], rotationY, health, healthLabel, live?}] }`

`poly` is the room outline (any shape); `x`/`z` are its bounding box. `live` is sent for refrigerant circuits only: ACs `{on, fan, air, evIn, evOut, sh, room, set}`, outdoor unit `{hz, dis, suc, lp, hp, fan}`. The renderer drives pipe flow from these.

## GET /api/devices?type=&room=&health=
`{ count, devices: [...same items as floor.devices] }`

## GET /api/devices/:id
```
{ id, type, label, room, name, time, health,
  readings: { ...raw simulated values },
  parts: [{ key, name, value, health, unit, series, inferred }],
  finding: null | { lvl, title, conf, ev: string[], steps: [{ t, p, go? }], trace? },
  overrides: null | { ...values set by commands } }
```
`steps[].p` is a part key. `steps[].go` links to another device id. `trace` is the AC id to trace from.

## GET /api/devices/:id/history?part=KEY
`{ id, part, unit, now, points: [[hour, value], ...] }` from 06:00 to 22:00 every 0.1 h.

## GET /api/devices/:id/commands
`{ id, commands: [{ name, args: { argName: [min,max] | allowedValues[] }, needsConfirmation }] }`

## POST /api/devices/:id/commands
Body `{ command, args?, confirmed?, by? }`.
- 200 `{ ok: true, device }`
- 409 `{ ok: false, needsConfirmation: true, error }` (unlock, washer stop)
- 400 `{ ok: false, error }` (unknown command, bad argument)

| type | commands |
|---|---|
| ac | `power {on}`, `setTemperature {celsius 16–30}`, `setFanSpeed {percent}` |
| light | `setLevel {percent}` |
| blinds | `setPosition {percent}` |
| plug | `power {on}` |
| lock | `lock`, `unlock` (confirm) |
| washer | `stop` (confirm) |
| purifier | `setFan {level 1–5}` |
| vacuum | `start`, `dock` |

## GET /api/sim · POST /api/sim
State: `{ t, playing, speed, scenario, fixT, scenarios: [{key, name}] }`.
POST body (all optional): `{ scenario, t, playing, speed, fix }`. Changing scenario clears command overrides. `fix: true` marks the current fault fixed at the current time; readings recover over 30 simulated minutes.

## GET /api/events (SSE)
- `event: clock` every 500 ms, data = sim state
- `event: health` when any device's health changes, data = `[{id, health}]`
- `event: layout` after a floor plan upload or reset, data = `{version}`

## GET /api/building
`{ version, custom, wallHeight, outdoorPad: {x, z}, rooms: [...], devices: [{id, type, room, name, position, rotationY}], furniture: [...], plan: null | {url, x0, x1, z0, z1} }`
`plan` bounds are the image's extent in metres on the floor (x, z). `furniture` lists the interiors (metres; w across, d front to back, rot = facing in radians, 0 faces +z). Kinds: column, chair, task_chair, table, round_table, desk, workstation, sofa, armchair, bed, cabinet, shelf, rack, counter, sink, toilet, stair, screen, railing, treadmill, bike, weight_rack, plant, door.

## POST /api/building
Body: `{ rooms: [{key, name, x:[x0,x1], z:[z0,z1], poly?: [[x,z]...], color}], furniture?: [{kind, x, z, w, d, rot?, h?}], devices: [{id, type, room, name, position:[x,y,z], rotationY?}], outdoorPad?, plan?: {dataUrl, x0, x1, z0, z1} }`.
Replaces the layout, clears command overrides and the fix time, bumps `version`. 400 with a message on invalid input (unknown type, duplicate id, bad image).

## DELETE /api/building
Back to the sample home.

## GET /api/building/plan
The uploaded image (404 for the sample home).

## POST /api/floorplan/parse
Body `{ image: dataURL }`. Proxied to the agent; returns `{ rooms: [{name, points: [[x, y]...]}], outdoor: {x, y} | null }` (room polygons) in 0..1 image coordinates, or `{error}` (422 without an API key, 502 if the agent is down).

## POST /api/chat
Proxy to the agent. See `agent-api.md`.
