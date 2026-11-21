"""Live smoke test against the real Ollama model. SmartThings commands are NOT sent (dry run);
status reads are live, so set IOT_API_BEARER_TOKEN in .env to test status questions and
relative changes ("by 5%") against the real devices.

Usage:  .venv/bin/python scripts/smoke_live.py              # built-in scenarios
        .venv/bin/python scripts/smoke_live.py "dim the lamp to 30"
Set LOG_LEVEL=DEBUG to print every prompt sent to the model.
"""
import asyncio
import logging
import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings  # noqa: E402
from app.core.agent import Agent  # noqa: E402
from app.core.llm import OllamaLLM  # noqa: E402
from app.normalize import build_context  # noqa: E402
from tests.conftest import sample_request  # noqa: E402

# (message, history as [(role, text)])
SCENARIOS = [
    ("hi", []),
    ("what can you do?", []),
    ("how many lights are there?", []),
    ("what can the Aqara Roller Shade Controller do?", []),
    ("is the Desk Lamp on?", []),
    ("which lights are on right now?", []),
    ("what's the shade position?", []),
    ("increase the Desk Lamp brightness by 5%", []),
    ("make Light 1 a bit warmer", []),
    ("dim all the lights by 10", []),
    ("turn on the Desk Lamp", []),
    ("dim the Desk Lamp to 40%", []),
    ("set light 1 color temperature to 4000", []),
    ("close the Aqara Roller Shade Controller", []),
    ("turn on the lamp", []),
    ("light 1", [("user", "turn on the lamp"),
                 ("assistant", "Which one do you mean: Desk Lamp, TV Lamp or side lamp?")]),
    ("set the Desk Lamp to 150%", []),
    ("turn on all the lights", []),
    ("turn on Light 1 and set the Desk Lamp brightness to 40%", []),
    ("turn on the Desk Lamp, dim it to 30% and set it to 3000K", []),
    ("close both shades and turn off the TV Lamp", []),
    ("set the Blinds Switch to cool mode", []),
    ("where is the restroom?", []),
    ("what is the capital of France?", []),
]


async def main() -> None:
    logging.basicConfig(level=settings.log_level if settings.log_level == "DEBUG" else "WARNING")
    s = replace(settings, st_dry_run=True)
    if not s.location_data_path.exists():
        s = replace(s, location_data_path=s.location_data_path.parent / "locations.example.json")
    agent = Agent(OllamaLLM(s), s)
    cases = [(" ".join(sys.argv[1:]), [])] if len(sys.argv) > 1 else SCENARIOS
    for message, history in cases:
        msgs = [{"role": r, "text": t} for r, t in history] + [{"role": "user", "text": message}]
        res = await agent.handle(build_context(sample_request(message, messages=msgs), None, s))
        print(f"\nUSER : {message}\n  -> [{res.data.get('skill')}] {res.data.get('request')}")
        print(f"BOT  : ({res.status}) {res.message}")
        for r in res.data.get("results", []):  # one SmartThings call per device
            cmds = ", ".join(f"{c['command']}{c['arguments'] or ''}" for c in r["command_generated"]["commands"])
            print(f"  cmd: {r['device_name']}: {cmds}")


if __name__ == "__main__":
    asyncio.run(main())
