"""FastAPI entry point. Run: uvicorn app.main:app --reload --port 8000"""
import json
from typing import Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import agent
from .config import ANTHROPIC_API_KEY, AGENT_MODEL, CORS_ORIGINS, PLATFORM_URL
from .platform import Platform, PlatformError
from .search import search

app = FastAPI(title="Twin agent", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])
platform = Platform()


class Msg(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatIn(BaseModel):
    messages: list[Msg] = Field(min_length=1)


@app.get("/health")
async def health():
    return {"ok": True, "mode": "claude" if ANTHROPIC_API_KEY else "demo", "model": AGENT_MODEL if ANTHROPIC_API_KEY else None, "platform": PLATFORM_URL}


@app.get("/search")
async def search_endpoint(q: str):
    """Plain search without the LLM, used by the web app's search box and by tests."""
    try:
        return search(q, await platform.floor())
    except PlatformError as e:
        return {"error": str(e)}


@app.post("/chat")
async def chat(body: ChatIn):
    async def stream():
        async for event, data in agent.run([m.model_dump() for m in body.messages], platform):
            yield f"event: {event}\ndata: {json.dumps(data)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})
