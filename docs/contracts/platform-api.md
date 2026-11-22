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
  finding: null | { lvl, title, conf, ev: string[], steps: [{ t, p, go? }], trace?, simulated? },
  fault: null | { key, name, level, severity, developing, parts: string[] },
  faults: [{ key, name, what, parts: string[] }],
  overrides: null | { ...values set by commands } }
```
`fault` is the simulated fault running on the device (`severity` 0..1 ramps up over about 6 s); `faults` is what can
be simulated on this device type.
`steps[].p` is a part key. `steps[].go` links to another device id. `trace` is the AC id to trace from.

## GET · POST · DELETE /api/devices/:id/fault
Technician fault simulation. GET → `{ id, type, label, levels: [{key, name}], faults: [{ key, name, what, parts }], active }`.
POST `{ key, level: early | developing | severe | degrading }` → starts the fault (`degrading` worsens steadily over
`DEGRADE_MINUTES`, default 6, so its failure can be predicted) (the device snapshot is returned); it changes the
readings, the damaged components' health (watch, then fault), the device's health on the map, the flows in the twin
and the finding (diagnosis + guided repair). Changing only the level keeps the fault developed. DELETE → back to
normal. 400 for an unknown fault or level, 404 for an unknown device. Faults are removed with their device.

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
- `event: journey` when a guest journey changes, data = `[{token, room, roomName, guest, state, eta, readyAt, steps, done}]`
- `event: predicted` when predicted failures or dispatches change, data = `{predictions, dispatches}`

## GET /api/building
`{ version, custom, wallHeight, outdoorPad: {x, z}, rooms: [...], devices: [{id, type, room, name, position, rotationY}], furniture: [...], plan: null | {url, x0, x1, z0, z1} }`
`plan` bounds are the image's extent in metres on the floor (x, z). `furniture` lists the interiors (metres; w across, d front to back, rot = facing in radians, 0 faces +z). Kinds: column, chair, task_chair, table, round_table, desk, workstation, sofa, armchair, bed, cabinet, shelf, rack, counter, sink, toilet, stair, screen, railing, treadmill, bike, weight_rack, plant, door.

## POST /api/building
Body: `{ title?, rooms: [{key, name, x:[x0,x1], z:[z0,z1], poly?: [[x,z]...], color, label?, labelAt?, zone?}], furniture?: [{kind, x, z, w, d, rot?, h?}], notes?: [{text, x, z, size?, rot?}], devices: [{id, type, room, name, position:[x,y,z], rotationY?}], outdoorPad?, plan?: {dataUrl, x0, x1, z0, z1} }`.
`title` is the floor name shown in the header (GET returns it as `title`). Doors are furniture items of kind `door` (`w` the opening, `rot` the wall's direction; the leaf opens towards (sin rot, cos rot)); `opening: true` is a doorway without a leaf, where two rooms are open to each other.
Replaces the layout, clears command overrides and the fix time, bumps `version`. 400 with a message on invalid input (unknown type, duplicate id, bad image).

## DELETE /api/building
Back to the sample home.

## GET /api/building/plan
The uploaded image (404 for the sample home).

## POST /api/floorplan/parse
Body `{ image: dataURL }`. Proxied to the agent (see `agent-api.md`): rooms, doors, furniture, scale estimate and
photo corners in 0..1 image coordinates, or `{error}` (422 when nothing is found, 502 if the agent is down).

## POST /api/chat
Proxy to the agent. See `agent-api.md`.

## Hotel and guests

| Method · path | What |
|---|---|
| `GET /api/hotel` | rooms that can be guest rooms, and the guest-room device kit |
| `POST /api/hotel` `{room}` or `{rooms?}` | refurnish and fit one room (or every candidate) as a guest room |
| `GET /api/guest?room=` · `POST /api/guest` | active passes and entrance rooms · new pass `{room, until (ms) or hours, entrance?, label?, verify?, allowUnlock?}` → `{token, path, pin, expiresAt}` |
| `DELETE /api/guest/:token` | withdraw a pass (host) |
| `POST /api/guest/:token/verify` `{pin}` | check-in PIN; sets a signed cookie; 5 wrong tries lock the pass |
| `GET /api/guest/:token` | the guest's room, its devices (state, status, allowed commands), entrances |
| `GET /api/guest/:token/building` · `/floor` | layout and live state for the guest's 3D view: only the room's devices, no plan image |
| `POST /api/guest/:token/devices/:id/commands` | a command on a device in the room; confirmation-only commands are refused, except unlocking when the pass allows it (403 otherwise, 503 when the device is offline) |
| `POST /api/guest/:token/chat` | the room assistant (SSE: `text`, `plan {actions, ask_first}`, `result {results}`, `ui_action`, `error`, `done`); send `confirm: actions` to run an approved plan |

Guest endpoints answer 401 `{verify: true}` until the PIN is entered (when the pass has one), 404 for an unknown
token and 410 once the pass expired, was withdrawn or the plan was replaced.

## Technician

| Method · path | What |
|---|---|
| `GET /api/alerts` | open alerts: device, room, level, title, since, reported evidence, affected parts, steps, service notes, recent events, status |
| `GET /api/maintenance?device=` · `POST /api/maintenance` | records `{deviceId, status: acknowledged·investigating·resolved, cause?, action?, notes?, by?}` |

`/api/events` also sends `alert` when a device raises a new alert.

Commands added for the hotel: AC `setMode`, `setSwing`, `setTimer`; light `power`, `setColorTemperature`; TV
`power`, `setVolume`, `setInput`; fan `power`, `setSpeed`, `setOscillation`; blinds `open`, `close`; purifier
`power`. Any device with a radio can get the `offline` fault: its commands then fail with `offline: true`.

## Integrations, door access, positioning

| Method · path | What |
|---|---|
| `GET /api/integrations` · `POST {token?, policy?}` | SmartThings connection and links; door-access policy `{stepUpMinutes, maxUnlocksPer10Min, autoRelockSec}` |
| `GET /api/integrations/smartthings` | devices in the connected SmartThings account |
| `POST /api/integrations/links {localId, stId, component?}` · `DELETE ?localId=` | link a twin device to a SmartThings device |
| `GET /api/locks?device=` | door-access audit log |
| `GET /api/positioning` · `POST {northDeg?, stepLength?}` | positioning settings, RTLS key, location QR checkpoints |
| `POST /api/positioning/rtls` (header `x-rtls-key`) | fixes from the hotel's positioning system: `{tag, x, z, accuracy?}` or `{fixes: [...]}` |
| `GET · POST /api/guest/:token/position` | the guest's latest fix; a fix from the guest's phone: `{checkpoint}` or `{x, z, accuracy, source: pdr}` |

Commands to a linked device go to `POST https://api.smartthings.com/v1/devices/{id}/commands` (base overridable
with `SMARTTHINGS_API`) as `{commands: [{component, capability, command, arguments}]}`: lock `lock.lock/unlock`,
`switch.on/off`, `switchLevel.setLevel`, `colorTemperature.setColorTemperature`,
`thermostatCoolingSetpoint.setCoolingSetpoint`, `airConditionerMode.setAirConditionerMode`,
`airConditionerFanMode.setFanMode`, `fanOscillationMode`, `audioVolume.setVolume`,
`mediaInputSource.setInputSource`, `fanSpeed.setFanSpeed`, `windowShade.open/close`,
`windowShadeLevel.setShadeLevel`, `airPurifierFanMode`, `robotCleanerMovement`. Status comes from
`GET /devices/{id}/status` and `/health`. A guest unlock answers 428 `{stepUp: true}` when the policy wants the
PIN again (send `pin` with the command), 429 when too many unlocks.
The guest's `/floor` feed carries `me: {x, z, accuracy, source, at}` while a fresh fix (under 30 s) exists.

## Hotel experience (lib/experience)

A 2-second loop on the server samples energy, refreshes comfort, advances guest journeys and re-checks predictions.
`GET /api/floor` carries the live part as `experience` (see bridge-api.md).

| Method · path | What |
|---|---|
| `GET /api/energy?room=` · `PATCH {perKWh?, currency?, co2PerKWh?}` | watts now, kWh / cost / CO2 today, avoided by eco, per room, biggest loads (`src: meter` from a SmartThings powerMeter, else `model`), hourly kWh and the trend · the tariff (also `ENERGY_TARIFF_PER_KWH`, `ENERGY_CURRENCY`, `GRID_CO2_KG_PER_KWH`) |
| `GET /api/comfort?room=` · `POST {room}` | comfort per room: score 0-100 and grade, thermal / air / light / sound parts (measured or estimated, and from what), temperature trend and minutes to the target, advice as device commands · apply a room's advice |
| `GET /api/arrivals` · `POST {action: eta·prepare·checkout, token, minutes?}` · `POST {action: housekeeping, id, status}` | every stay's journey (`booked → en_route → preparing → ready → arrived ⇄ away → departed`) and housekeeping tasks · the front desk's actions |
| `GET /api/guest/:token/journey` · `POST {action: on_my_way {minutes} · walking {metres} · arrived · away · prepare · prefs {temp, scene, curtain, tvWelcome} · comfort}` | the guest's journey, their room's comfort and energy · the guest's side (`comfort` applies the advice their pass allows) |
| `GET /api/predictions` · `POST {deviceId, reason?}` · `PATCH {deviceId, status: en_route·on_site·done}` | predicted failures `{deviceId, part, title, etaMin, etaText, confidence, basis: degradation-model·scenario·trend·usage-model, evidence, action}` and dispatches · send the right technician · update the dispatch |

