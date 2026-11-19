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
Body `{ image: dataURL }` (PNG, JPEG, WebP, GIF). Claude vision detects rooms.
200 `{ rooms: [{name, points: [[x, y], ...]}], outdoor: {x, y} | null, photo_corners: [[x, y] ×4] | null }`: photo_corners (TL, TR, BR, BL) is set when the image is a skewed photo and should be straightened first; each room is a polygon (any shape), coordinates as fractions of the image (y down).
422 `{ error }` when there is no API key, the model returns no rooms, or the image is not a data URL.

## GET /health
`{ ok, mode: "claude" | "demo", model, platform }`

## Environment
`ANTHROPIC_API_KEY` (empty = demo mode), `AGENT_MODEL` (default `claude-sonnet-5-5`), `PLATFORM_URL` (default `http://localhost:3000`), `CORS_ORIGINS`, `MAX_TOOL_ROUNDS` (8).
