> From the original SmartThings Assistant repository (agent + chat). In the digital twin PoC the `chat/` part is
> replaced by the web app (see README.md, "In the digital twin PoC").

# Architecture

This document explains how the SmartThings Assistant works from end to end: the parts, what happens
during one message, the contracts between the parts, and where to make common changes. It assumes no
prior knowledge of the code.

## 1. The parts

```
┌──────────────┐  POST /api/chat    ┌──────────────────────┐  POST /control/stream  ┌─────────────────────────┐
│   Browser    │ ─────────────────▶ │  chat/  (Next.js)    │ ─────────────────────▶ │  agent/  (FastAPI)      │
│  chat widget │ ◀───────────────── │  server route        │ ◀───────────────────── │                         │
│ localStorage │   NDJSON stream    │  adds devices+token  │   Server-Sent Events   │  router ─▶ one skill    │
└──────────────┘                    └──────────────────────┘                        └──────┬───────────┬──────┘
                                                                                           │           │
                                                                         JSON-schema calls │           │ REST
                                                                                           ▼           ▼
                                                                                   ┌──────────┐ ┌──────────────────┐
                                                                                   │  Ollama  │ │ SmartThings API  │
                                                                                   │  (LLM)   │ │ commands/status/ │
                                                                                   └──────────┘ │ health           │
                                                                                                └──────────────────┘
```

| Part | Responsibility | Holds state? |
|---|---|---|
| **Browser** (`chat/src/components`, `chat/src/lib/useChats.ts`) | Shows the chat, stores chats in `localStorage` (up to 50 chats × 300 messages), picks which earlier messages to send as context | Chat history, in this browser only |
| **Chat server route** (`chat/src/app/api/chat/route.ts`) | The only thing the browser calls. Adds the device list and the optional SmartThings token, forwards to the agent, relays progress | No |
| **Agent** (`agent/`) | Understands the message, chooses a skill, decides devices and actions, calls SmartThings, writes the reply | No (each request is independent) |
| **Ollama** | Runs the open-source LLM. Every call returns JSON constrained by a schema | No |
| **SmartThings REST API** | Executes commands (`POST /devices/{id}/commands`), reports live state (`GET /status`, `GET /health`) | The real devices |

The browser never talks to the agent or to SmartThings directly. Tokens stay on the servers.

## 2. One message, step by step

Example: the user types **"increase the Desk Lamp brightness by 5%"**.

1. **Browser → chat server.** `useChats.ts` sends `{message, history}` to `/api/chat`.
   `history.ts` drops failed turns and messages older than 30 minutes, and keeps at most 10 messages
   (3000 characters in total).
2. **Chat server → agent.** `route.ts` adds `device_name_id_context` and `device_id_command_context`,
   built from `chat/src/data/devices.json`, plus `Authorization: Bearer <SMARTTHINGS_TOKEN>` when one is set.
   It then calls `POST {BACKEND_URL}/control/stream`, or `/control` if the agent has no streaming endpoint.
3. **Agent builds the turn context** (`agent/app/normalize.py`): devices with their command lists, the
   trimmed history, the token, and each device's room from `agent/data/rooms.json`.
4. **Router (LLM call 1).** `agent/app/core/router.py` sees only the skill names, one-line descriptions
   and the last few turns, never the device list. It returns
   `{"skill": "device_control", "request": "increase the Desk Lamp brightness by 5%"}`. The `request`
   is a standalone sentence, so follow-ups like "yes" or "the second one" become complete requests.
5. **Skill runs.** For `device_control`:
   - **Device choice.** "Desk Lamp" is an exact device name, so no LLM call is needed. Otherwise the
     `device_plan` LLM call picks names from a closed list.
   - **Action choice (LLM call 2).** `action_select` sees only this device's compact action list and
     returns `{"action": "switchLevel.setLevel", "change": "increase", "value": "5%"}`.
   - **Current value.** For a relative change, the agent reads `GET /devices/{id}/status` and finds
     `components.main.switchLevel.level.value = 49`.
   - **Code computes the value.** 49 + 5 = 54, kept within the allowed range (1–100). If the light was
     off, `switch.on` is added in front.
   - **Execute.** One `POST /devices/{id}/commands` per device, with all of that device's commands.
   - **Reply.** Written from a template: "Done! Desk Lamp brightness is set to 54%."
6. **Progress streaming.** While this runs, the agent emits SSE `status` events ("Understanding",
   "Finding device", "Checking status", "Sending command"). The chat route turns them into NDJSON lines,
   and the widget shows them live. The final event carries the full response.
7. **Display.** When `data.status == "clarify"` the widget shows `data.question`, otherwise `message`.
   A `success` reply also shows "Command sent to Desk Lamp".

A typical turn makes **2 LLM calls** (router + one skill step), or 3 when the device isn't named exactly.

## 3. The agent's design (why it works with a small model)

The agent runs on a small open-source model, so it is built to keep every model decision narrow and
checked:

| Principle | How |
|---|---|
| **One decision per LLM call, with only the data it needs** | The router never sees devices. A skill sees only the shortlisted devices, or one device's actions. Prompts stay under about 2500 characters, and a test enforces this. |
| **Closed choices** | Whenever the model selects a skill, device or action, the JSON schema uses an `enum` of the valid values. |
| **Code writes facts, the model writes prose** | The model never writes SmartThings command JSON. Code validates values, rebuilds the exact command from the original templates, and writes confirmations and clarifying questions from templates. |
| **No device IDs in prompts** | IDs stay in code. Names map back to IDs after the model answers. |
| **One LLM entry point** | `LLM.complete_json(system, user, schema, label)` handles structured output, JSON extraction, schema validation and retries with feedback. |

### Skills

Each skill is one file in `agent/app/skills/`, registered with `@register` and found automatically.

| Skill | Handles | How |
|---|---|---|
| `device_control` | Commands, including several devices or actions, and relative changes | plan → action_select → validate → (read status if relative) → execute → template reply |
| `device_status` | "Is it on?", "which lights are on?", "what's the shade position?" | pick devices → read `/status` + `/health` fresh → LLM answers from readings only |
| `device_info` | What devices exist, counts, what a device can do | One reply call with a compact device/action list |
| `rooms` | Rooms, what is in a room, which room a device is in | One reply call with room data from `agent/data/rooms.json` |
| `location` | Venue directions and facilities (off by default) | One reply call with the top matching entries |
| `chitchat` | Greetings, "who are you?", off-topic | One reply call |

### Device commands → actions

The frontend's command file lists every command variant separately (for example an AC mode command once
per mode). `agent/app/devices/catalog.py` merges them into **actions**, such as
`airConditionerMode.setAirConditionerMode | value: one of [auto, cool, dry]`. A placeholder argument
such as `"Enter a number in range 1 to 100"` becomes a numeric slot with that range.

### Live state

`agent/app/devices/state.py` reads `GET /devices/{id}/status` and `/health`, at most 10 devices at a time,
fresh on every request with no cache. It extracts values at
`components.<component>.<capability>.<attribute>.value` using a table of standard capabilities
(`switch.switch` → "power", `switchLevel.level` → "brightness", `windowShadeLevel.shadeLevel` →
"shade position", …), and skips nulls. A device whose `/health` says `OFFLINE` is reported as offline,
never with stale values. With `ST_DRY_RUN=true`, commands are blocked but status reads still happen,
since reading never changes a device.

## 4. Contracts between the parts

### Chat server → agent: `POST /control` and `POST /control/stream`

Request (the same shape lounge-web's `ChatBot.tsx` sends, so the agent also works with that frontend):
```jsonc
{
  "message": "turn on the Desk Lamp",
  "messages": [{"role": "user", "text": "..."}, {"role": "assistant", "text": "..."}],
  "device_name_id_context": {"Desk Lamp": "<device-id>"},
  "device_id_command_context": {"<device-id>": [{"commands": [{"component": "main", "capability": "switch", "command": "on", "arguments": []}]}]},
  "extras": {}            // optional: e.g. "rooms_context" (same shape as rooms.json)
}
```
Header: `Authorization: Bearer <SmartThings token>` (optional. Without it, the agent uses `IOT_API_BEARER_TOKEN`).

Response: `{"status": "success|clarify|error", "message": "...", "data": {...}}`
- `success`: at least one device command ran. `data.results[]` has one entry per device.
- `clarify`: any reply that did not execute a command: answers, questions, small talk, status replies.
  `data.question` equals `message`.
- `error`: everything failed.
- `device_status` replies add `data.states[]`: `{device_name, online, readings: {"brightness": "70%"}}`.

`/control/stream` sends `event: status {stage, text}` while working, then `event: final` with the same
body `/control` would return (or `event: error`). Full details: [agent/SKILL.md §5](agent/SKILL.md).

### Browser → chat server: `POST /api/chat`

`{message, history: [{role, text}]}` → NDJSON lines: `{"type":"status",...}`, then
`{"type":"reply","reply":{status,text,skill,device}}` or `{"type":"error","error":"..."}`.
Types are in `chat/src/lib/types.ts`. `GET /api/health` reports whether the agent is reachable and
drives the online dot.

## 5. Data and configuration

| Data | Lives in | Used by |
|---|---|---|
| Devices and their commands | `chat/src/data/devices.json`, sent with every request | Agent (all device skills) |
| Same file, as a test fixture | `agent/data/devices.sample.json` | Agent tests and the smoke script |
| Rooms | `agent/data/rooms.json` (git-ignored; example in `rooms.example.json`), or `extras.rooms_context` | `rooms` skill, and room names in device lists |
| Venue locations | `agent/data/locations.json` or `location_context` | `location` skill (off by default) |
| Chat history | Browser `localStorage` (`smartthings-chat:v1`) | Chat widget |
| SmartThings token | `chat/.env.local` `SMARTTHINGS_TOKEN` (forwarded) or `agent/.env` `IOT_API_BEARER_TOKEN` (fallback) | Agent → SmartThings |

The two device files are the same today. When you change the devices, update
`chat/src/data/devices.json`. Update `agent/data/devices.sample.json` too if the tests should cover the change.

Device names are what users type, so a name must match in `devices.json` and `rooms.json`.

## 6. Where to change what

| I want to… | Change |
|---|---|
| Add or rename a device | `chat/src/data/devices.json` (and `agent/data/rooms.json` for its room) |
| Add a new kind of question or feature | A new skill in `agent/app/skills/` ([agent/SKILL.md §4.1](agent/SKILL.md)) |
| Make a capability read better in replies | Labels and confirmations in `agent/app/devices/catalog.py` |
| Report a new status reading | `READINGS` in `agent/app/devices/state.py` |
| Change "a bit brighter" step sizes | `DEFAULT_STEPS` in `agent/app/devices/catalog.py` |
| Switch the LLM | `agent/.env` `OLLAMA_MODEL` / `OLLAMA_BASE_URL` (or implement the `LLM` protocol for another backend) |
| Change how much history is sent | `HISTORY_LIMITS` in `chat/src/lib/history.ts` (the agent trims again with `HISTORY_MAX_*`) |
| Change the chat's look | `chat/src/components/*`, `chat/src/app/globals.css` |

## 7. Known limits

- One skill per message: "turn on the lamp and where is the cafe?" handles only one part.
- Status uses standard SmartThings capability attributes, not the presentation API. Custom capabilities
  show at most 2 simple values each.
- Relative changes work only for numeric settings (brightness, shade position, color temperature,
  setpoints, volume). Option lists such as fan modes can't step.
- One status answer reads at most `MAX_STATUS_DEVICES` devices (default 15).
- Light color (hue and saturation) isn't offered in chat yet. SmartThings hue is 0–100, not degrees.
- Chat history is per browser. Nothing is stored on a server.
