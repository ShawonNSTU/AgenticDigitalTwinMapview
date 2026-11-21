---
name: assistant
description: How to understand, modify and extend the SmartThings Agent (FastAPI + Ollama OSS model, skill-based agentic architecture). Read fully before editing any file in this repo.
---

# SmartThings Agent: guide for AI coding assistants

> This is the `agent/` part of the SmartThings Assistant monorepo. Paths in this file are relative to
> `agent/`, and commands run from there. The chat UI is in `../chat`. The system overview is in
> `../ARCHITECTURE.md`, and repo-wide rules are in `../SKILL.md`.

You are editing a chat agent for a SmartThings demo experience zone. Users chat with
"SmartThingsBot" in the chat widget (`../chat`) or the `lounge-web` frontend. The bot controls real devices through the
SmartThings REST API, answers questions about the devices, helps with venue locations, and
makes small talk. It runs on a **small open-source model via Ollama** (default `gpt-oss:20b`).
Every design decision below exists to keep that model accurate.

## 1. Golden rules (do not break these)

1. **Small, precise prompts.** Each LLM call does ONE decision with ONLY the data it needs.
   Never put the full device JSON, the full history, or another skill's data in a prompt.
   `tests/test_agent.py::test_prompts_are_small_and_never_contain_device_ids` enforces < 2500 chars.
2. **Closed choices, not free generation.** Whenever the model selects something (skill,
   device, action), the JSON schema uses an `enum` of the valid values. Code then maps the
   choice back to real data. The model never writes the SmartThings command JSON.
3. **Code writes facts; the model writes only prose.** Clarifying questions ("Which one do you
   mean: A or B?"), option lists, error texts and confirmations come from code templates.
   Only the `ReplySkill`s (chitchat, device_info, location) produce free text, and their
   prompts contain only the data they may talk about.
4. **Device IDs never go into any prompt.** IDs are kept in code (`Device.id`) only.
5. **Every LLM call goes through `LLM.complete_json(system, user, schema, label)`.** It
   handles structured output, JSON extraction, schema validation and self-correcting retries.
   Don't call `ollama` directly anywhere else.
6. **Keep the HTTP contract** of `POST /control` (section 5). `../chat/src/app/api/chat/route.ts` and
   lounge-web depend on it. If you change it, update the chat in the same change.
7. **Run `pytest` after every change.** Add a test for every new behaviour.

## 2. Request flow

```
POST /control ─► app/normalize.py  build TurnContext (devices, trimmed history, token, extras)
              ─► app/core/agent.py Agent.handle
                   ├─ Router (app/core/router.py)    LLM #1: {"skill": enum, "request": standalone sentence}
                   │     sees: skill names/descriptions/examples + last 6 turns. NO devices.
                   └─ Skill.run(ctx, request)        skills get the standalone request, not the history
                         device_control: [exact-name fast path | LLM device_plan: steps of {devices, request}]
                                         → LLM action_select per step (list of {action, change, value}; identical
                                           devices share a call)
                                         → validate values in code; change=increase/decrease reads GET /status for
                                           those devices only and computes an absolute, clamped value per device
                                         → ONE SmartThings POST per device with all its commands (devices in
                                           parallel) → template reply
                         device_status:  [exact-name fast path | LLM status_targets: device names]
                                         → GET /status + /health fresh (code builds readings) → LLM reply from
                                           readings only (template reply, no LLM, when nothing could be read)
                         device_info / chitchat / location: one ReplySkill LLM call → {"reply": "..."}
              ◄─ SkillResult(status, message, data) ─► app/api.py to_response ─► ApiResponse JSON
```

Because the router rewrites follow-ups into standalone requests (user: "light 1" after the bot
asked "Which lamp?" becomes "turn on the Desk Lamp"), downstream prompts stay history-free.

## 3. File map

| Path | Responsibility |
|---|---|
| `main.py` | Entry point (`python main.py`). |
| `app/config.py` | All settings from env / `.env` (see `.env.example`). Add new settings here. |
| `app/api.py` | FastAPI routes; thin. `to_response` keeps the frontend contract. |
| `app/schemas.py` | Pydantic request/response models. |
| `app/normalize.py` | Request → `TurnContext`; accepts both device formats; trims and dedupes history. |
| `app/core/llm.py` | `OllamaLLM.complete_json`: the only LLM entry point. |
| `app/core/jsonutil.py` | `extract_json` (tolerant parsing) + minimal JSON-schema `validate`. |
| `app/core/router.py` | Skill selection + standalone rewrite prompt. |
| `app/core/agent.py` | Orchestrator: route → run skill → attach `skill`/`request` to data. |
| `app/core/skill.py` | `Skill`, `ReplySkill`, `SkillResult`, `@register`, auto-discovery. |
| `app/core/context.py` | `TurnContext`, `Device`, `Message` dataclasses. |
| `app/devices/catalog.py` | Compacts raw ST commands into `Action`s; value validation; labels; confirmations. |
| `app/devices/matching.py` | Deterministic name matching and shortlisting (no LLM). |
| `app/devices/state.py` | Live state: `read_states` (GET /status + /health), `DeviceState` readings, setter → attribute map. |
| `app/integrations/smartthings.py` | SmartThings REST client: commands (`ST_DRY_RUN` blocks them) and status/health reads (always live). |
| `app/skills/*.py` | One file per skill, auto-discovered. |
| `data/devices.sample.json` | Copy of the frontend's device command set (`../chat/src/data/devices.json`), used by tests. Keep the two in sync. |
| `data/locations.example.json` | Example venue data. Real data goes in `data/locations.json` (git-ignored). |
| `data/rooms.example.json` | Example rooms (unique id, name, devices). Real data goes in `data/rooms.json` (git-ignored). |
| `app/rooms/store.py` | Loads rooms, looks up a device's room and attaches it to devices (no LLM). |
| `app/integrations/room_activity.py` | Placeholder for the room/device activity API (returns nothing until disclosed). |
| `scripts/smoke_live.py` | Runs real scenarios against Ollama (dry-run for SmartThings). |
| `tests/` | `FakeLLM` scripted by prompt label; unit and end-to-end tests. |

## 4. Recipes

### 4.1 Add a new skill (most common change)

Q&A-style skill (text answer only): subclass `ReplySkill` and implement only `build_prompt`.

```python
# app/skills/opening_hours.py
from app.core.context import TurnContext
from app.core.skill import ReplySkill, register

SYSTEM = """You are {bot}. Answer questions about opening hours.

Hours:
{hours}

Rules:
1. Answer ONLY from the hours above. Otherwise say you don't know.
2. One sentence, plain text.
"""  # do NOT add the JSON format line, ReplySkill appends it

@register
class OpeningHoursSkill(ReplySkill):
    name = "opening_hours"                       # unique, snake_case; used as the router enum value
    description = "Questions about opening and closing times."   # ONE line, for the router
    examples = ["when do you close?", "are you open on Sunday?"]  # 2-4 short ones
    capability = "tell you the opening hours"    # shown by chitchat ("I can ...")
    progress_text = "Checking hours"  # shown live in the chat; keep it 1-3 words

    def is_available(self, ctx: TurnContext) -> bool:
        return bool(ctx.extras.get("hours"))     # hide from router when there is no data

    def build_prompt(self, ctx: TurnContext, request: str) -> tuple[str, str]:
        return SYSTEM.format(bot=self.settings.bot_name, hours=ctx.extras["hours"]), f"Question: {request}"
```

Action-style skill: subclass `Skill` and implement `async run(ctx, request) -> SkillResult`.
Follow the `device_control.py` pattern: each LLM step uses an enum schema, code validates, and
code writes the user-facing text.

Checklist for a new skill:
- [ ] Module in `app/skills/`, `@register`, unique `name`. No other registration needed.
- [ ] `description` is distinct from other skills so the router can tell them apart. If two
      skills overlap, sharpen both descriptions and examples rather than adding router rules.
- [ ] `is_available` returns False when the skill has no data, so the router never offers it.
- [ ] New per-request data goes through `ControlRequest.extras` (→ `ctx.extras`) or a new
      optional field in `schemas.py` plus `normalize.build_context`.
- [ ] Data sent to the model is filtered to the few relevant entries (see `location.py`, which
      keeps the top `MAX_ENTRIES` by word overlap).
- [ ] Tests in `tests/` using `make_agent({...label: [replies]})`. The label is the
      `label=` passed to `complete_json`; for `ReplySkill` it is the skill `name`.
- [ ] Add a scenario to `scripts/smoke_live.py`.

### 4.2 Support a new device capability / nicer wording
Edit only `app/devices/catalog.py`:
- `CAPABILITY_LABELS[capability]`: short noun phrase shown in device lists ("fan speed").
- `COMMAND_LABELS[(capability, command)]`: verb phrase shown in action lists ("set fan speed").
- `CONFIRMATIONS[(capability, command)]`: success text with `{device}` and `{value}`.
Unknown capabilities still work (labels come from camelCase), they just read less nicely.

For live state, edit `app/devices/state.py`:
- `READINGS[(capability, attribute)]`: label of a status value shown to the status prompt ("shade position").
- `DEFAULT_UNITS`: unit when the status has none.
- `SETTER_ATTRIBUTES[(capability, command)]`: which attribute a setter changes, used to read the current
  value for relative changes. Unlisted `setFooBar` commands map to `fooBar` automatically.
And in `catalog.py`, `DEFAULT_STEPS[capability]`: the amount for "a bit brighter" with no number.

### 4.3b Relative changes ("increase by 5%")
`action_select` returns `change: set|increase|decrease` per action. For increase/decrease, `value` is
only the amount (`"5%"`, `"10"` or `""`). Only actions with a numeric slot can step
(`Action.change_amount` raises `ValueProblem` otherwise). `DeviceControlSkill.resolve_changes` reads
`/status` only for devices with a relative pick, then `Action.stepped` computes `current ± amount`:
`""` = `DEFAULT_STEPS`, `%` on a non-0–100 range = percent of the range, then it clamps to the slot's
range. Already at the limit or status unreadable → a note, nothing sent for that device. Raising
`switchLevel` on a light that is off also sends `switch.on` first, in the same POST.

### 4.3 How hard-coded command sets become actions
Input per device: a list of SmartThings commands `{component, capability, command, arguments}`.
Variants with the same `(component, capability, command)` merge into one `Action`:
- argument is a short word/number string (`"cool"`, `"UP"`, `"3"`) → fixed **option**
- argument is a number (`39`) → free numeric **slot** (the number is only an example)
- argument is a sentence (`"put an integer % here ..."`) → free **slot**; the sentence is the
  hint. `integer`/`number`/`%` in the hint make it an integer, and `%` adds a 0-100 range.
- no arguments → no value needed
`Action.resolve(value)` validates the model's value (case- and punctuation-insensitive option
match, number parsing, range check). It raises `ValueProblem`, whose text is the clarifying
question. `Action.build(args)` returns the exact command that is POSTed.
Non-`main` components get ids like `thermostatCoolingSetpoint.setCoolingSetpoint@freezer`.

### 4.4 Change a prompt
Prompts are module-level `SYSTEM`/`*_SYSTEM` constants next to the code that uses them.
Rules for OSS models:
- Short role line → data block → numbered rules (≤ 6) → final line `Reply with JSON only: {...}`.
- Literal `{` `}` in a template that is `.format()`-ed must be doubled (`{{ }}`).
- Use plain words and concrete examples. Avoid negations stacked in one rule. One rule = one case.
- Prefer a new enum value (e.g. `"AMBIGUOUS"`) over asking the model to write a question.
- Don't paste history into skill prompts; rely on the router's standalone `request`.
- Check the real prompt with `LOG_LEVEL=DEBUG .venv/bin/python scripts/smoke_live.py "msg"`.

### 4.5 Swap or tune the model
`.env`: `OLLAMA_MODEL`, `OLLAMA_THINK` (gpt-oss: `low|medium|high`; other thinking models
`true|false`; empty = default), `LLM_STRUCTURED_OUTPUT` (Ollama JSON-schema decoding; set
`false` only if a model breaks with it, since parsing and validation still apply),
`LLM_MAX_RETRIES`, `LLM_TEMPERATURE` (keep 0). To use a non-Ollama backend, implement the
`LLM` protocol in `app/core/llm.py` and pass it to `create_app(settings, llm)`.

## 5. HTTP contract (keep compatible)

`POST /control` (header `Authorization: Bearer <SmartThings token>`, used for device calls):
```json
{
  "message": "turn on the Desk Lamp",
  "messages": [{"text": "How may I assist you?", "role": "assistant"}, {"text": "turn on the Desk Lamp", "role": "user"}],
  "device_name_id_context": {"Desk Lamp": "<device-id>"},
  "device_id_command_context": {"<device-id>": [{"component": "main", "capability": "switch", "command": "on", "arguments": []}]},
  "devices": null,            // optional alternative: [{"id","name","room","commands"|"actions"}]
  "location_context": null,   // optional, same shape as data/locations.json
  "extras": {}                // optional, free-form data for skills (ctx.extras); "rooms_context" = same shape as data/rooms.json
}
```
Response: `{"status": "success|clarify|error", "message": "<text for the user>", "data": {...}}`
- `data.status` always equals `status`. For `clarify`, `data.question == message`. The frontend
  shows `data.question` when `data.status == "clarify"`, otherwise `message`.
- `clarify` = any reply that did not execute an action (questions, answers, chitchat).
- On device actions `data.results` lists one entry per device called: `device_id`, `device_name`,
  `command_generated` (`{"commands": [...]}`, every command for that device in one POST),
  `api_result` (`{status_code, response}`), `status` (`success|error`). When exactly one device was
  called, its `device_id`, `device_name`, `command_generated`, `api_result` are also at the top level
  of `data` (the original single-device contract). Always `skill`, `request`.
- Multi-device turns: `success` if at least one device succeeded (the message also names failures and
  skipped devices); `error` if every call failed; `clarify` (nothing executed) if any part needs a
  question (ambiguous device, vague request, missing/invalid value), or nothing was left to send
  (relative change already at its limit, or the current value couldn't be read).
- `device_status` replies are `clarify` with `data.states`: one entry per device read, `{device_id,
  device_name, online (true|false|null), readings: {"brightness": "70%", ...}, error?}`. With exactly
  one device, `device_id` and `device_name` are also at the top level.

`POST /control/stream`: same request; replies with Server-Sent Events while the agent works:
`event: status` `{"stage": "routing"|"<skill>"|"<skill>.<step>", "text": "Finding device"}`
(steps include `device_control.status` and `device_status.read` while status is being read)
as each step starts, then one `event: final` with the exact `/control` response body (or
`event: error` `{"detail"}`). The chat shows `text` live. Progress comes from `ctx.progress(stage,
text)` (a no-op when nobody listens), and each skill's default line is `progress_text`.
Never add model calls or waits just to report progress.

Other routes: `GET /`, `GET /health`, `GET /skills`, `POST /chatbot/action` (legacy passthrough).

## 6. Run and test

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cp .env.example .env          # then fill in OLLAMA_BASE_URL, IOT_API_BEARER_TOKEN, ...
.venv/bin/python -m pytest -q # offline, uses FakeLLM, must stay green
.venv/bin/python scripts/smoke_live.py      # real model, SmartThings dry-run
.venv/bin/python main.py      # serve on :8000
```
`FakeLLM` asserts that every scripted reply matches the schema the code sent, so a schema
change that breaks a test is a real signal.

## 7. Known limits and ideas
- Several devices and several actions per message are supported inside `device_control` (one
  router call, one `device_plan` call, one `action_select` call per step and action set). Mixing
  skills in one message ("turn on the lamp and where is the cafe?") still handles only one skill.
- Many devices: `device_plan` sees at most `MAX_DEVICE_CANDIDATES` devices (word-overlap shortlist),
  so "all the lights" in a very large venue may miss some. Raise the setting or filter by room first.
- Live status uses standard capability attributes (`READINGS`), not the frontend's presentation
  paths (`/presentation` needs `presentationId`/`manufacturerName`, which the request doesn't carry).
  Custom capabilities used by a device's commands still show up to 2 scalar attributes each.
- `device_status` reads at most `MAX_STATUS_DEVICES` devices per question (default 15) to keep the prompt small.
- Relative changes only work for numeric values. Option lists (fan mode "low/medium/high") can't step yet.
- No streaming responses; a single-device turn makes 2-3 LLM calls (router + 1-2 skill calls), or fewer
  when one exact device name is in the request and no "and"/"all"/"," etc. (`MULTI_HINT`).
