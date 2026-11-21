"""FastAPI app. Routes are thin: normalize the request -> Agent.handle -> ApiResponse."""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncIterator, Optional

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from app.config import Settings, settings as default_settings
from app.core.agent import Agent
from app.core.llm import LLM, OllamaLLM
from app.core.skill import SkillResult
from app.integrations.smartthings import SmartThingsClient
from app.normalize import build_context
from app.schemas import ApiResponse, ChatbotActionRequest, ControlRequest

log = logging.getLogger("agent.api")


def _bearer(authorization: Optional[str]) -> Optional[str]:
    if authorization and authorization.startswith("Bearer "):
        return authorization[7:].strip() or None
    return None


def to_response(result: SkillResult) -> ApiResponse:
    # The frontend shows data.question when data.status == "clarify", else `message`.
    data = {**result.data, "status": result.status}
    if result.status == "clarify":
        data["question"] = result.message
    return ApiResponse(status=result.status, message=result.message, data=data)


def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def create_app(settings: Settings = default_settings, llm: LLM | None = None) -> FastAPI:
    logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    app = FastAPI(title="SmartThings Agent")
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"]
    )
    agent = Agent(llm or OllamaLLM(settings), settings)
    st = SmartThingsClient(settings)
    app.state.agent = agent
    running: set[asyncio.Task] = set()

    @app.get("/")
    async def root():
        return {"message": f"{settings.bot_name} agent is active"}

    @app.get("/health")
    async def health():
        return {"status": "ok", "model": settings.ollama_model, "skills": [s.name for s in agent.skills]}

    @app.get("/skills")
    async def skills():
        return [{"name": s.name, "description": s.description, "examples": s.examples} for s in agent.skills]

    @app.post("/control", response_model=ApiResponse)
    async def control(request: ControlRequest, authorization: Optional[str] = Header(None)):
        ctx = build_context(request, _bearer(authorization), settings)
        try:
            result = await agent.handle(ctx)
        except Exception as exc:  # never leak a stack trace to the chat UI
            log.exception("unhandled error")
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        log.info("reply [%s/%s]: %s", result.data.get("skill"), result.status, result.message)
        return to_response(result)

    @app.post("/control/stream")
    async def control_stream(request: ControlRequest, authorization: Optional[str] = Header(None)):
        """Same as /control, but streams Server-Sent Events while the agent works:
        `status` {stage, text} events as each step starts, then one `final` event with the ApiResponse
        (or an `error` event). Progress is pushed from the running turn, so it adds no extra work or wait."""
        ctx = build_context(request, _bearer(authorization), settings)
        queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()
        ctx.on_progress = lambda stage, text: queue.put_nowait((stage, text))

        async def events() -> AsyncIterator[str]:
            task = asyncio.create_task(agent.handle(ctx))
            try:
                while True:
                    getter = asyncio.create_task(queue.get())
                    done, _ = await asyncio.wait({getter, task}, return_when=asyncio.FIRST_COMPLETED)
                    if getter in done:
                        stage, text = getter.result()
                        yield sse("status", {"stage": stage, "text": text})
                        continue
                    getter.cancel()
                    break
                while not queue.empty():  # flush anything reported right before the turn ended
                    stage, text = queue.get_nowait()
                    yield sse("status", {"stage": stage, "text": text})
                try:
                    result = task.result()
                except Exception as exc:  # never leak a stack trace to the chat UI
                    log.exception("unhandled error")
                    yield sse("error", {"detail": str(exc)})
                    return
                log.info("reply [%s/%s]: %s", result.data.get("skill"), result.status, result.message)
                yield sse("final", to_response(result).model_dump())
            finally:
                # If the client went away mid-turn, let the turn finish (a device command may be in
                # flight) but keep a reference so the task isn't garbage-collected.
                if not task.done():
                    running.add(task)
                    task.add_done_callback(running.discard)

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/chatbot/action", response_model=ApiResponse)
    async def chatbot_action(request: ChatbotActionRequest, authorization: Optional[str] = Header(None)):
        """Legacy passthrough kept for compatibility: POSTs {message, context} to the device's commands URL."""
        res = await st.post_raw(
            request.device_id, {"message": request.message, "context": request.context}, _bearer(authorization)
        )
        if not res.ok:
            return ApiResponse(status="error", message=res.error or "request failed", data=res.as_dict())
        return ApiResponse(status="success", message="Command executed successfully", data=res.as_dict())

    return app
