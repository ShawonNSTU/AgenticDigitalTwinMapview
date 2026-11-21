# Assistant: the twin's one chat agent

The twin's only chat assistant, for the **administrator, the technician and the guest** (different pages, same
agent; the web app sends the role and limits what each may see and do). It runs on an Ollama model
(`OLLAMA_MODEL`, `OLLAMA_BASE_URL`) and works on the zone's **real SmartThings devices** and on every other
**simulated device**, through the twin.

```
 Browser ─▶ web /api/chat (staff)  or  /api/guest/{pass}/chat (guest)
              │  builds the device list for the role, opens a short session (role + scope)
              ▼
            this agent :8100  POST /control/stream   router -> one skill -> Ollama
              │  Bearer <session>
              ▼
            web /api/st/v1/devices/{id}/commands|status|health   (SmartThings-compatible)
            web /api/st/v1/twin/floor|insight/{id}               (staff only: health, evidence)
              ▼
            simulator  or  api.smartthings.com (the twin holds SMARTTHINGS_TOKEN; this agent never sees it)
```

| Skill | Who | What |
|---|---|---|
| `smart_control` | all | **goals and feelings**: "I'm cold", "too bright", "open the window, I want to see outside", "everything off except the desk lamp". Reads the devices' live state and what each one IS (from the twin: "the left window: a back-lit pane behind the curtain") plus the room guide, reasons (streamed as reasoning), follows the purpose when the words conflict, and sends only validated commands. `device_control` hands over to it when a request does not map to a named device |
| `device_control` | all | power, brightness, colour temperature, shade, AC temperature/mode/fan, TV, fan, purifier, lock, vacuum; relative changes; many devices at once |
| `device_status` | all | live state, read fresh from the twin |
| `knowledge` | all | **any question**, answered from the twin's knowledge graph (RAG): rooms (how many, sizes, neighbours, furniture), devices (where, real or simulated, state, what they can do), guests, alerts, routines and the history of everything done since the floor plan was loaded (who did what, when). Cites its sources. A guest sees only their room, their stay and the floor's public facts |
| `chitchat` | all | greetings and small talk |
| `routines` | all | built-in routines (movie night, good night, morning, welcome, focus, away) **and your own**: after a change of several things the assistant offers "save this as a routine?"; "yes, call it Cosy" stores it, "run Cosy" repeats it, "delete Cosy" removes it. Staff routines are shared by staff; a guest's belong to that pass |
| `diagnostics` | admin, technician | find devices by type/room/health on the whole building, show them in 3D, explain a fault from the twin's evidence |
| `maintenance` | admin, technician | list open alerts, acknowledge, investigate, resolve with cause and action, fix (clears the fault) |
| `scene` | admin, technician | 3D view: highlight, focus, open parts, trace piping, layers, demo scenario, simulated time |
| `checkin` | admin, technician | guest check-in (link + PIN for a room), who is checked in, check out |
| floor-plan reading | web app | `POST /floorplan/parse`: rooms, doors, scale and names from a plan image (OpenCV, optional Claude vision) |

- **Roles**: staff see the whole building; a guest only the guest's room, with the pass's controls and
  temperature range. Commands that need confirmation (unlock, stop a wash) are never offered to the agent.
- **Names**: the zone's real SmartThings labels ("Light 3"). Where a kind repeats, the room goes first
  ("Gym Room Air conditioner").
- **Robust**: unreachable model -> a plain message and the fix (staff see `OLLAMA_BASE_URL`); a turn has a
  deadline (`TURN_TIMEOUT_S`); `MAX_CONCURRENT_TURNS` queues load; `GET /health?deep=true` and `GET /ready` check
  Ollama, the model and the device API; invalid model output is retried with feedback; every command is built
  and validated by code, never taken raw from the model.

## Run it
```bash
cd assistant
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cp .env.example .env          # set OLLAMA_BASE_URL (your Ollama server) and OLLAMA_MODEL; .env is gitignored
.venv/bin/python main.py      # :8100 (the web app's ASSISTANT_URL); or: docker build -t st-agent . 
.venv/bin/python -m pytest -q                         # unit tests, no model needed
TWIN_URL=http://localhost:3000 .venv/bin/python -m pytest -q   # + end to end through the running twin
```
The chat panel shows a green dot when the agent, Ollama and the model are ready, otherwise what to fix.

## Standalone

Point `IOT_API_BASE_URL` at `https://api.smartthings.com/v1/devices` and set `IOT_API_BEARER_TOKEN`; the original
chat app (not included here) or any client of `POST /control` can then use it directly.

**What it does**
- **Device control**: uses the hard-coded SmartThings command sets the frontend sends. Covers
  power, dimmer, light color temperature, blinds/shade open/close/position. Light color (hue and saturation) is not offered in chat yet.
  Relative changes ("increase the dimmer by 5%", "a bit brighter") read the current value from
  `/status` first and send an absolute value clamped to the allowed range.
- **Device status**: live questions ("is the Desk Lamp on?", "which lights are on?", "what's the
  shade position?"). Reads `/devices/{id}/status` and `/health` fresh with the request's token.
- **Device info**: which devices or device types exist, counts, what a device or feature does,
  which modes it has.
- **Location help** (off by default, `LOCATION_SKILL_ENABLED=true` to enable): places, directions and
  facilities, from `data/locations.json` or the request's `location_context`. Room and location
  questions are planned to move to a future room API.
- **Rooms**: which rooms exist, which devices are in each room, which room a device is in, from
  `data/rooms.json` (or the request's `rooms_context`). Activity per room/device is a placeholder
  until that API is disclosed (`app/integrations/room_activity.py`).
- **Chitchat**: greetings, "who are you", and polite out-of-scope replies.
- Asks which device you mean when it's unclear, follows up across turns, and retries invalid
  model output with feedback.

`POST /control` is drop-in compatible with the old service. Clients: the chat in [`../chat`](../chat)
(set its `BACKEND_URL` to this server) and lounge-web's `ChatBot.tsx`.

## Quick start
```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cp .env.example .env    # set OLLAMA_BASE_URL, OLLAMA_MODEL, IOT_API_BEARER_TOKEN
cp data/locations.example.json data/locations.json   # optional: venue info for the location skill
cp data/rooms.example.json data/rooms.json           # then put in the real rooms and devices
.venv/bin/python -m pytest -q
.venv/bin/python main.py                             # http://localhost:8100/docs
```
Try against the real model without touching devices: `.venv/bin/python scripts/smoke_live.py`.

## Architecture in one paragraph
A router LLM call picks one skill and rewrites the message as a standalone request. The chosen
skill runs its own small prompt with only the data it needs. Device control chooses the device
and action from enums built from a compacted command catalog: a light's raw commands become a few
actions. Code validates the value, rebuilds the exact SmartThings command and writes the reply.
New features are new files in `app/skills/`.

See **[SKILL.md](SKILL.md)** for the full guide (architecture, rules, recipes, API contract). It
is written so any AI assistant can safely edit the project.

## Knowledge graph and retrieval (RAG)

The twin (`web/lib/kg/`) keeps what the assistant knows:
- **Graph**, rebuilt from the live twin on every question: floor -> rooms (size, area, neighbours, furniture, doors,
  printed notes) -> devices (real SmartThings or simulated, live state, health, what each can do), guests, alerts,
  maintenance, routines, technicians. One fact sheet per node, plus a floor overview with every count.
- **Journal** (`journal.ts`, `web/.data/journal.jsonl`): every action on the website after the floor plan is
  loaded: device commands from anyone (with who and the result), changes real devices report on their own (the
  SmartThings app, a wall switch), devices placed/moved/renamed/removed, floor plans uploaded, guest room setup,
  check-in/out and PINs, faults, alerts raised and cleared, maintenance records, routines saved, simulation changes.
  A new floor plan starts a new journal.

`GET /api/st/v1/twin/kg` returns the documents for the turn's scope. `app/knowledge/retriever.py` ranks them with
BM25, plus Ollama embeddings when `OLLAMA_EMBED_MODEL` is pulled (`ollama pull nomic-embed-text`; vectors cached by
text hash; keyword-only if it is missing), merged by reciprocal rank fusion; the overview is always included. The
model answers only from the numbered facts and cites them; the UI shows them as "Based on".

## Reasoning
For `knowledge`, `smart_control` and `diagnostics_explain` the model thinks before it answers (Ollama `think`), and
the thinking streams to the chat as **Reasoning** (`REASONING`, `REASONING_LABELS`). Other steps (routing, picking
an action) stay fast. Skills add their own rationale with `ctx.reason()`.

## Device meanings
The twin sends each device's `about` (what it is, where, other names) and a room guide (`extras.room_guide`, e.g. "to
see the outside view: open the curtain fully and turn on both window lights"). Edit them in
`web/lib/sim/stzone.ts` (`ST_MEANING`, `ZONE_GUIDE`); other devices get their kind, room and common names.

## Several tasks in one message (plans)
"Dim Light 2 and Light 3, save that as Reading, and tell me how many rooms there are": the router returns a plan
(`tasks`, one per kind of work, and `parallel` when no task depends on another) in the same call it already makes,
so a single request costs nothing extra. The agent posts the to-do list (`plan` event), runs the tasks one by one
(or at the same time when independent), reports each (`task` events: running, done, needs_input, failed), hands
each task's device changes to the next (so "save that as a routine" saves exactly them) and answers with one
combined summary. A failing task does not stop the others. Several device changes of the same kind stay ONE task.
