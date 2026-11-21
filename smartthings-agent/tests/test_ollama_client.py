"""The real Ollama client against a tiny fake Ollama server: URL, auth header, keep_alive, structured output,
retry with feedback, and the "server unreachable" path. (No model needed.)"""
from __future__ import annotations

import json
import threading
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app.config import Settings
from app.core.llm import LLMUnavailable, OllamaLLM

SCHEMA = {"type": "object", "properties": {"reply": {"type": "string"}}, "required": ["reply"]}


class FakeOllama:
    def __init__(self, replies):
        self.replies, self.requests = list(replies), []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def _send(self, obj):
                body = json.dumps(obj).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                outer.requests.append(("GET", self.path, dict(self.headers), None))
                self._send({"models": [{"model": "gpt-oss:20b", "name": "gpt-oss:20b"}]})

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                outer.requests.append(("POST", self.path, dict(self.headers), json.loads(raw)))
                content = outer.replies.pop(0) if outer.replies else "{}"
                self._send({"model": "gpt-oss:20b", "created_at": "2026-01-01T00:00:00Z", "message": {"role": "assistant", "content": content}, "done": True})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


@pytest.fixture
def fake():
    made = []

    def make(replies):
        f = FakeOllama(replies); made.append(f); return f
    yield make
    for f in made:
        f.close()


def cfg(url, **kw):
    return replace(Settings(), ollama_base_url=url, ollama_model="gpt-oss:20b", **{"llm_timeout_s": 5, "llm_max_retries": 2, **kw})


async def test_request_carries_model_schema_keep_alive_and_key(fake):
    f = fake(['{"reply": "hi"}'])
    llm = OllamaLLM(cfg(f.url, ollama_api_key="secret", ollama_keep_alive="1h"))
    out = await llm.complete_json(system="s", user="u", schema=SCHEMA, label="t")
    assert out == {"reply": "hi"}
    _, path, headers, body = f.requests[-1]
    assert path == "/api/chat" and body["model"] == "gpt-oss:20b" and body["format"] == SCHEMA
    assert body["keep_alive"] == "1h" and body["think"] == "low" and body["options"]["temperature"] == 0
    assert {k.lower(): v for k, v in headers.items()}["authorization"] == "Bearer secret"


async def test_invalid_json_is_fed_back_and_retried(fake):
    f = fake(["not json", '{"reply": "ok"}'])
    out = await OllamaLLM(cfg(f.url)).complete_json(system="s", user="u", schema=SCHEMA, label="t")
    assert out == {"reply": "ok"}
    retry = f.requests[-1][3]["messages"]
    assert retry[-1]["role"] == "user" and "invalid" in retry[-1]["content"] and retry[-2]["content"] == "not json"


async def test_unreachable_server_raises_llm_unavailable():
    llm = OllamaLLM(cfg("http://127.0.0.1:9", llm_timeout_s=1))        # nothing listens on port 9
    with pytest.raises(LLMUnavailable) as e:
        await llm.complete_json(system="s", user="u", schema=SCHEMA, label="router")
    assert "OLLAMA_BASE_URL=http://127.0.0.1:9" in str(e.value)


async def test_check_reports_reachable_and_model_present(fake):
    f = fake([])
    assert await OllamaLLM(cfg(f.url)).check() == {"reachable": True, "model_present": True, "models": ["gpt-oss:20b"]}
    assert (await OllamaLLM(replace(cfg(f.url), ollama_model="llama3")).check())["model_present"] is False
    down = await OllamaLLM(cfg("http://127.0.0.1:9")).check()
    assert down["reachable"] is False and down["error"]
