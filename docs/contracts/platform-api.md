# Platform API: simulated device platform (web/app/api)

Base URL: the Next.js app (`http://localhost:3000` in development). All responses are JSON unless noted.
Time `t` is in hours (6.0 to 22.0). Health is `ok`, `watch` or `fault`.

## GET /api/floor
`{ time, scenario, rooms: [{key, name, x:[x0,x1], z:[z0,z1], color}], devices: [{id, type, label, room, name, position:[x,y,z], rotationY, health, healthLabel}] }`

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

## POST /api/chat
Proxy to the agent. See `agent-api.md`.
