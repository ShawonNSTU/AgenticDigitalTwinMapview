# agent-backend

FastAPI service for the digital twin's **floor-plan reading** (`POST /floorplan/parse`): rooms, doors, scale and
printed names with OpenCV (and Tesseract, if installed), merged with Claude vision when `ANTHROPIC_API_KEY` is set.
It also has the deterministic device search (`GET /search?q=`).

The chat assistant is **not** here any more: one assistant (the SmartThings agent, Ollama) answers for the
administrator, the technician and the guest. See [../smartthings-agent](../smartthings-agent/README.md).

```bash
pip install -e ".[dev]"
cp .env.example .env     # ANTHROPIC_API_KEY is optional: only the vision step of floor-plan reading uses it
uvicorn app.main:app --reload --port 8000
pytest
```

Needs the web app running (`PLATFORM_URL`, default http://localhost:3000), which serves the simulated platform.

| File | Purpose |
|---|---|
| `app/main.py` | `GET /search?q=`, `POST /floorplan/parse`, `GET /health` |
| `app/plan_cv.py` | floor plan image processing: walls, door gaps, rooms on wall centre lines, OCR names, scale |
| `app/floorplan.py` | plan reading entry point: runs plan_cv and Claude vision, merges their results |
| `tests/plan_synth.py` | synthetic plans (solid, hatched, thin-line, grey walls) with known rooms and doors |
| `app/search.py` | deterministic natural-language search: type/room synonyms, health words, ids |
| `app/platform.py` | HTTP client for the platform API |
| `evals/search_cases.json` | search eval set, run by `tests/test_evals.py` |

Event stream and endpoints: [docs/contracts/agent-api.md](../docs/contracts/agent-api.md).
