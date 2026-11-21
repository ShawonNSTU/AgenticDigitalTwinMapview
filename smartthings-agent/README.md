# SmartThings Agent

Skill-based (agentic) rewrite of `loungex-chatbot`: the SmartThingsBot. It runs on an OSS model through Ollama
(default `gpt-oss:20b`). In this repository it is the digital twin's **SmartThings agent**: the twin's chat panel
(host) and the guest page's room assistant talk to it, and it controls the SmartThings Experience Zone through the
twin.

## In the digital twin PoC

```
 Browser ─▶ web /api/st-agent (host) or /api/guest/{pass}/st-agent (guest)
              │  builds the device list and rooms from the live twin, opens a short session
              ▼
            this agent :8100  POST /control/stream  (router -> one skill -> Ollama)
              │  IOT_API_BASE_URL = http://localhost:3000/api/st/v1/devices, Bearer <session>
              ▼
            web /api/st/v1/devices/{id}/commands|status|health   (SmartThings-compatible)
              │  runs every command through the twin: 3D view at once, zone rules (Blinds Switch before the
              │  shade), guest permissions; a device linked to a real SmartThings device gets the real command
              ▼
            simulator  or  api.smartthings.com (the twin holds SMARTTHINGS_TOKEN; this agent never sees it)
```

- Device ids are the twin's (`LT-03`); the real SmartThings deviceId of a linked device works too. Names are the
  zone's real SmartThings labels ("Light 3", "Aqara Roller Shade Controller").
- The chat shows the agent's progress steps; the 3D view highlights the devices it changed or read and turns to a
  single one.
- A guest's agent only sees and controls the guest's room, with the pass's controls and temperature range.
  Commands that need confirmation (unlocking the door) are never offered to the agent.
- `chat/` from the original repository is not used: its jobs (device list, token, streaming) are the web app's.

Run it next to the web app (Ollama with the model pulled):
```bash
cd smartthings-agent
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cp .env.example .env          # OLLAMA_BASE_URL, OLLAMA_MODEL; IOT_API_BASE_URL already points at the twin
.venv/bin/python main.py      # :8100 (the web app's ST_AGENT_URL)
TWIN_URL=http://localhost:3000 .venv/bin/python -m pytest -q   # unit tests + end to end through the twin
```
Then choose "SmartThings agent" in the chat panel (host) or the room assistant (guest page).

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
