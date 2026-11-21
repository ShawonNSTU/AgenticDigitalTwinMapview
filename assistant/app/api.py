"""FastAPI app. Routes are thin: normalize the request -> Agent.handle -> ApiResponse."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, AsyncIterator, Optional

import httpx

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

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
    model = llm or OllamaLLM(settings)
    agent = Agent(model, settings)
    st = SmartThingsClient(settings)
    app.state.agent = agent
    running: set[asyncio.Task] = set()
    gate = asyncio.Semaphore(max(1, settings.max_concurrent_turns))   # turns running at once; the rest wait

    async def turn(ctx) -> SkillResult:
        """One agent turn with a wait for a free slot and an overall deadline (a hung model must not hang the chat)."""
        async with gate:
            try:
                return await asyncio.wait_for(agent.handle(ctx), timeout=settings.turn_timeout_s)
            except asyncio.TimeoutError:
                log.error("turn timed out after %.0fs: %s", settings.turn_timeout_s, ctx.message)
                return SkillResult("error", "That took too long. Please try again.", {"error": "timeout", "timeout": True})

    async def twin_up() -> dict[str, Any]:
        """Is the SmartThings-compatible API this agent calls reachable? Any HTTP answer (even 401) means yes."""
        t0 = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=3) as client:
                r = await client.get(f"{settings.st_api_base_url}/health-check")
            return {"reachable": True, "status": r.status_code, "ms": round((time.monotonic() - t0) * 1000)}
        except httpx.HTTPError as exc:
            return {"reachable": False, "error": str(exc) or type(exc).__name__}

    @app.get("/")
    async def root():
        return {"message": f"{settings.bot_name} agent is active"}

    @app.get("/health")
    async def health(deep: bool = False):
        """Liveness (always fast). `?deep=true` also checks the Ollama server + model and the device API."""
        out: dict[str, Any] = {"status": "ok", "model": settings.ollama_model, "skills": [s.name for s in agent.skills]}
        if deep:
            check = getattr(model, "check", None)
            out["llm"] = {"url": settings.ollama_base_url, **(await check() if check else {"reachable": True, "model_present": True})}
            out["device_api"] = {"url": settings.st_api_base_url, **(await twin_up())}
            out["ready"] = bool(out["llm"]["reachable"] and out["llm"]["model_present"] and out["device_api"]["reachable"])
        return out

    @app.get("/ready")
    async def ready():
        """200 when the model and the device API are both reachable, else 503 with what is wrong."""
        out = await health(deep=True)
        if not out["ready"]:
            raise HTTPException(status_code=503, detail=out)
        return out

    @app.get("/skills")
    async def skills():
        return [{"name": s.name, "description": s.description, "examples": s.examples} for s in agent.skills]

    @app.post("/control", response_model=ApiResponse)
    async def control(request: ControlRequest, authorization: Optional[str] = Header(None)):
        ctx = build_context(request, _bearer(authorization), settings)
        try:
            result = await turn(ctx)
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
        queue: asyncio.Queue[tuple[str, dict[str, str]]] = asyncio.Queue()
        ctx.on_progress = lambda stage, text: queue.put_nowait(("status", {"stage": stage, "text": text}))
        ctx.on_reasoning = lambda label, text: queue.put_nowait(("reasoning", {"label": label, "text": text}))

        async def events() -> AsyncIterator[str]:
            task = asyncio.create_task(turn(ctx))
            try:
                while True:
                    getter = asyncio.create_task(queue.get())
                    done, _ = await asyncio.wait({getter, task}, return_when=asyncio.FIRST_COMPLETED)
                    if getter in done:
                        event, payload = getter.result()
                        yield sse(event, payload)
                        continue
                    getter.cancel()
                    break
                while not queue.empty():  # flush anything reported right before the turn ended
                    event, payload = queue.get_nowait()
                    yield sse(event, payload)
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

    @app.post("/floorplan/parse")
    async def floorplan_parse(body: dict[str, Any]):
        """Read an uploaded floor plan image ({image: dataURL}): rooms as polygons, doors, furniture, scale, printed
        names (0..1 image fractions). Image processing needs no LLM; a Claude key adds vision. Imported lazily so the
        assistant also runs where OpenCV is not installed."""
        image = body.get("image")
        if not isinstance(image, str) or not image or len(image) > 12_000_000:
            return JSONResponse({"error": "send {image: <data URL>} up to 12 MB"}, status_code=422)
        try:
            from app.floorplan.reader import ParseError, analyze_plan
        except ImportError as exc:
            return JSONResponse({"error": f"floor-plan reading needs numpy and opencv-contrib-python-headless ({exc})"}, status_code=503)
        try:
            return await analyze_plan(image)
        except ParseError as exc:
            return JSONResponse({"error": str(exc)}, status_code=422)

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
