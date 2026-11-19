# agent-backend

FastAPI service with a Claude tool-use agent for the digital twin. It searches devices, reads insights,
sends whitelisted commands (risky ones only after the user confirms) and drives the 3D map by emitting
`ui_action` events that the web page forwards to the Godot renderer. It also reads uploaded floor plans
(`POST /floorplan/parse`): rooms, doors, scale and printed names with OpenCV (and Tesseract, if installed),
merged with Claude vision when a key is set.

```bash
pip install -e ".[dev]"
cp .env.example .env     # ANTHROPIC_API_KEY empty = demo mode (rule-based, no LLM)
uvicorn app.main:app --reload --port 8000
pytest
```

Needs the web app running (`PLATFORM_URL`, default http://localhost:3000), which serves the simulated platform.

| File | Purpose |
|---|---|
| `app/main.py` | `POST /chat` (SSE), `GET /search?q=`, `POST /floorplan/parse`, `GET /health` |
| `app/plan_cv.py` | floor plan image processing: walls, door gaps, rooms on wall centre lines, OCR names, scale |
| `app/floorplan.py` | plan reading entry point: runs plan_cv and Claude vision, merges their results |
| `tests/plan_synth.py` | synthetic plans (solid, hatched, thin-line, grey walls) with known rooms and doors |
| `app/agent.py` | system prompt, tool loop (max 8 rounds), demo mode |
| `app/tools.py` | tool schemas and executors; each returns `(result, ui_events)` |
| `app/search.py` | deterministic natural-language search: type/room synonyms, health words, ids |
| `app/platform.py` | HTTP client for the platform API |
| `evals/search_cases.json` | search eval set, run by `tests/test_evals.py` |

Event stream and endpoints: [docs/contracts/agent-api.md](../docs/contracts/agent-api.md).
