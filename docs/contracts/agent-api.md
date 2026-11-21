# Assistant API (assistant/)

Legacy note: the older `POST /chat` and `GET /search` of the removed agent-backend are gone; everything below is the one assistant.

## Skills (who can use them)
`device_control`, `device_status`, `device_info`, `rooms`, `chitchat`, `routines`: everyone. Staff only (administrator,
technician): `diagnostics` (find devices, explain faults), `scene` (3D view, layers, scenario, time), `building` (rooms,
floor plan), `checkin` (guest passes: create, list, withdraw), `maintenance` (alerts: acknowledge, investigate,
resolve, fix). Everyone in the web app: `experience` (comfort of a room and "make it comfortable", energy / cost / CO2 /
savings, a guest's arrival: on my way, prepare, heading out, is my room ready; staff also: expected guests, ETA,
check-out, predicted failures, sending a technician). Each skill gets its data from the twin per turn, so a new floor plan, new devices or a new fault
change what the assistant knows at once.

## POST /floorplan/parse (assistant service, :8100)
`{ image: <data URL> }` -> rooms as polygons, doors, furniture, scale and printed names (0..1 image fractions).
Image processing needs no LLM; `ANTHROPIC_API_KEY` adds a vision step. The web app calls it from `/api/floorplan/parse`.

## POST /api/chat (staff) and POST /api/guest/{pass}/chat (guest)
One assistant (assistant) for the administrator, the technician and the guest. Body
`{ messages: [{role, content}], room? }` (staff `room`: limit to one room, default the whole building; a guest always
gets their pass's room). The role comes from the sign-in cookie (`tech:` = technician, else administrator).
Events: `step` `{stage, text}` (every step the agent takes, live; `tool` is the same for older clients, staff only), `text` `{text, skill}` (the reply), `result` `{results: [{device_id, label, ok, summary, error?}]}` (each device changed), `sources` `{items: [{id, kind, title, devices}]}` (knowledge-graph facts the answer used), `suggestions` `{items}` (follow-ups), `offer` `{kind: 'save_routine', text}` (shown as a card), `reasoning` `{label, text}` (the model's thinking, streamed), `plan` `{tasks: [{id, title, skill, status}], parallel}` and `task` `{id, status: running|done|needs_input|failed, summary?}` (a message with several tasks, shown as a live to-do list), `choices` `{items}` (answers to a clarifying question, as buttons), `card` `{kind: 'guest_pass', link, pin, room, until}` (staff), `ui_action` (`highlight` devices it changed, read or
found; `focusDevice`; `openDevice {id, part?}` with `select`; `clearHighlight`; `setLayer {layer, on}` (a guest only `comfort` / `energy`); `dispatchRoute {id}` (staff: the technician's route in 3D)), `error`, `done`.
`GET /api/kg` (staff): counts and open alerts for the panel's home (`?graph=1`: nodes, edges, documents).
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

## /api/st/v1/twin/{kg | floor | insight/{id} | ops/{op}}
`kg` (every scope): the knowledge graph's documents for the session's scope (`?graph=1` adds nodes and edges).
 (staff sessions; a guest only the routine ops and `comfort`, `comfort_apply`, `energy`, `journey`, `journey_action`, always for their own room and stay)
`floor` -> `{time, scenario, rooms, devices: [{id, name, type, room, health, finding?}]}`; `insight/{id}` -> the
device's parts with health and the finding (evidence, confidence, guided steps). Read by the agent's `diagnostics` skill.
`POST ops/{op}`: `layout`, `alerts`, `alert_update`, `faults`, `clear_fault`, `simulate_fault`, `sim`, `passes`,
`pass_create`, `pass_revoke`, `routines`, `routine_run`, `routine_save`, `routine_delete`, `comfort {room?}`, `comfort_apply {room}`,
`energy {room?}`, `journey`, `journey_action {token, action: on_my_way|eta|prepare|away|prefs|checkout, minutes?, temp?, scene?, curtain?}`,
`predictions`, `dispatch_tech {device_id, reason?}` (lib/integrations/stops.ts; experience services in lib/experience/; routines in
lib/sim/routines.ts). Saved routines are kept per owner (staff, or one guest pass) in `web/.data/routines.json`. The web app
sends the owner's last executed commands back as `extras.last_actions` (30 minutes) so "save this" can store them.
