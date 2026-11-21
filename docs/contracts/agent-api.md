# Agent API (agent-backend)

## POST /chat
Body: `{ messages: [{ role: "user" | "assistant", content: string }] }` (full conversation, newest last).
Response: `text/event-stream`. Events, in any order, ending with `done`:

| event | data | client does |
|---|---|---|
| `text` | `{ text }` | append to the assistant answer |
| `tool` | `{ name, summary }` | show a small grey line |
| `ui_action` | a bridge message (see bridge-api.md, without `source`) | forward to the renderer |
| `select` | `{ id }` | open the device in the side panel |
| `error` | `{ message }` | show it in the chat |
| `done` | `{}` | stop the spinner |

## GET /search?q=
Search without the model: `{ query, understood: {types, rooms, health, ids}, count, devices: [{id, label, room, health}] }`.

## POST /floorplan/parse
Body `{ image: dataURL }` (PNG, JPEG, WebP, GIF). Reads any floor plan: image processing (`app/plan_cv.py`, always),
merged with Claude vision when `ANTHROPIC_API_KEY` is set.
200 `{ rooms: [{name, label?, points: [[x, y], ...], source?}], doors: [{kind: "door", fx, fy, fw, fd, rot}], furniture: [{kind, fx, fy, fw, fd, rot}], outdoor: {x, y} | null, photo_corners: [[x, y] ×4] | null, width_m: number | null, scale_note: string | null, method: string }`.
- `photo_corners` (TL, TR, BR, BL) is set when the image is a photo of a sheet taken at an angle; straighten it and read again.
- Each room is a polygon (any shape) on the wall centre lines; `label` is the text printed on the plan, `source: "vision"` marks a room only the vision model found.
- Doors sit on wall lines: centre `fx, fy`, opening `fw` (fraction of the image width), `rot` such that `(cos rot, -sin rot)` runs along the wall.
- `width_m` is the estimated real width of the image in metres (from door widths, else wall thickness); `scale_note` says which.
- `furniture` comes from the vision model only (empty without a key).
All coordinates are fractions of the image (x right, y down).
422 `{ error }` when no rooms are found, or the image is not a readable data URL.

## GET /health
`{ ok, mode: "claude" | "demo", model, platform }`

## Environment
`ANTHROPIC_API_KEY` (empty = demo mode), `AGENT_MODEL` (default `claude-sonnet-5-5`), `PLATFORM_URL` (default `http://localhost:3000`), `CORS_ORIGINS`, `MAX_TOOL_ROUNDS` (8).


# SmartThings agent (smartthings-agent)

The web app runs the SmartThings agent's turns and gives it a SmartThings-compatible API onto the twin.

## POST /api/chat (staff) and POST /api/guest/{pass}/chat (guest)
One assistant (smartthings-agent) for the administrator, the technician and the guest. Body
`{ messages: [{role, content}], room? }` (staff `room`: limit to one room, default the whole building; a guest always
gets their pass's room). The role comes from the sign-in cookie (`tech:` = technician, else administrator).
Events: `tool` (staff only: progress), `text` (the reply), `ui_action` (`highlight` devices it changed, read or
found; `focusDevice`; `openDevice {id, part?}` with `select`; `clearHighlight`), `result` (guest only:
`{results: [{device_id, label, ok, error?}]}`), `error`, `done`.
`GET /api/chat`: `{ ok, ready, problem, model, skills, llm }`; `problem` says what to fix (Ollama URL, model not
pulled, device API down).

The web app sends the agent `{message, messages, devices: [{id, name, room, actions}], extras: {rooms_context}}`
(built from the live twin; `extras.role` = admin | technician | guest) with `Authorization: Bearer <session>`: a random token valid for 3 minutes that carries
the turn's scope (staff, or one guest pass).

## /api/st/v1/devices/{id}/{commands|status|health}
Same paths and bodies as `api.smartthings.com/v1/devices`, for the agent (`IOT_API_BASE_URL`). Needs a session
token (401 otherwise); `{id}` must be in the session's scope (404 otherwise).
- `POST commands {commands: [{component, capability, command, arguments}]}`: each is mapped to a twin command
  (`switch.on` -> `power`, `switchLevel.setLevel` -> `setLevel`, `colorControl.setColor` -> `setHueSat`,
  `windowShadeLevel.setShadeLevel` -> `setPosition`, `thermostatCoolingSetpoint` -> `setTemperature`, ...) and run
  through the twin (host: `dispatch`; guest: `guestCommand`). 200 `{results: [{id, status: "COMPLETED"}]}`; 403/409/422
  `{error: {message}}` when refused, offline or invalid.
- `GET status`: the twin's state as a SmartThings status document (the real device's reported state when linked).
- `GET health`: `{deviceId, state: "ONLINE" | "OFFLINE"}`.
Commands that need confirmation (unlock, stop a wash) are never offered or accepted.

## /api/st/v1/twin/{floor | insight/{id}} (staff sessions only; 403 for a guest)
`floor` -> `{time, scenario, rooms, devices: [{id, name, type, room, health, finding?}]}`; `insight/{id}` -> the
device's parts with health and the finding (evidence, confidence, guided steps). Read by the agent's `diagnostics` skill.
