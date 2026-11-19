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
