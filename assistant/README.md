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
| `device_control` | all | power, brightness, colour temperature, shade, AC temperature/mode/fan, TV, fan, purifier, lock, vacuum; relative changes; many devices at once |
| `device_status` | all | live state, read fresh from the twin |
| `device_info`, `rooms`, `chitchat` | all | what exists, rooms, small talk |
| `diagnostics` | admin, technician | find devices by type/room/health on the whole building, show them in 3D, explain a fault from the twin's evidence |

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
