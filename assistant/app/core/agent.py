"""The agent: route the message to a skill, run it, return a SkillResult. No business logic here."""
from __future__ import annotations

import asyncio
import logging
from dataclasses import replace
from typing import Any

from app.config import Settings
from app.core.context import TurnContext
from app.core.llm import LLM, LLMError, LLMUnavailable
from app.core.fastlane import direct as plain_command
from app.core.router import Route, Router
from app.core.trace import reasoning_sink
from app.core.skill import Skill, SkillResult, load_skills

log = logging.getLogger("agent")

BUSY_MESSAGE = "Sorry, I'm having trouble understanding that right now. Could you please try again?"
SAVE_OFFER = "\nWould you like to save this as a routine to run again later? Just tell me a name."
DOWN_MESSAGE = "The AI model is not reachable right now, so I can't answer. Please try again in a moment."


def task_state(res: SkillResult) -> str:
    """A task's box on the to-do list: done (changed something or answered), needs_input (asked a question), failed."""
    if res.status == "error":
        return "failed"
    if res.status == "clarify" and (res.message.rstrip().endswith("?") or res.data.get("options")):
        return "needs_input"
    return "done"


class Agent:
    def __init__(self, llm: LLM, settings: Settings, skills: list[Skill] | None = None):
        self.settings = settings
        self.skills = skills if skills is not None else load_skills(llm, settings)
        self.router = Router(llm, settings.bot_name)

    def available_skills(self, ctx: TurnContext) -> list[Skill]:
        return [s for s in self.skills if s.is_available(ctx)]

    async def handle(self, ctx: TurnContext) -> SkillResult:
        token = reasoning_sink.set(ctx.on_reasoning)
        try:
            return await self._handle(ctx)
        finally:
            reasoning_sink.reset(token)

    async def _handle(self, ctx: TurnContext) -> SkillResult:
        skills = self.available_skills(ctx)
        if not skills:
            return SkillResult("error", "No skills are enabled on this server.")
        by_name = {s.name: s for s in skills}
        ctx.capabilities = [s.capability for s in skills if s.capability]

        ctx.progress("routing", "Understanding")
        # a plain command naming one device needs no routing: straight to device control (the model is not asked)
        if "device_control" in by_name and plain_command(ctx.message, ctx.devices) is not None:
            log.info("fast lane: %s", ctx.message)
            skill, result = await self._run_one(ctx, by_name["device_control"], ctx.message, by_name)
            result.data.setdefault("skill", skill.name)
            result.data.setdefault("request", ctx.message)
            result.data["fast_lane"] = True
            return result
        try:
            route = await self.router.route(ctx, skills)
        except LLMUnavailable as exc:
            log.error("router: model unreachable: %s", exc)
            return SkillResult("error", DOWN_MESSAGE, {"error": str(exc), "llm_unavailable": True})
        except LLMError as exc:
            log.error("router failed: %s", exc)
            return SkillResult("error", BUSY_MESSAGE, {"error": str(exc)})

        if route.tasks:
            return await self._run_plan(ctx, route, by_name)
        skill, result = await self._run_one(ctx, by_name[route.skill], route.request, by_name)
        self._offer_routine(skill, result, by_name)
        result.data.setdefault("skill", skill.name)
        result.data.setdefault("request", route.request)
        return result

    async def _run_one(self, ctx: TurnContext, skill: Skill, request: str, by_name: dict[str, Skill]) -> tuple[Skill, SkillResult]:
        """Run one skill on one request (with the hand-over to a better skill). Never raises for model errors."""
        ctx.progress(skill.name, skill.progress_text)
        try:
            result = await skill.run(ctx, request)
        except LLMUnavailable as exc:
            log.error("skill %s: model unreachable: %s", skill.name, exc)
            return skill, SkillResult("error", DOWN_MESSAGE, {"error": str(exc), "llm_unavailable": True})
        except LLMError as exc:
            log.error("skill %s failed: %s", skill.name, exc)
            return skill, SkillResult("error", BUSY_MESSAGE, {"error": str(exc)})

        # a skill that could not do it hands over to a better one (a literal command that maps to no device ->
        # the reasoning skill, which knows what each device is and its current state)
        target = result.data.pop("delegate", None)
        if target and target in by_name and target != skill.name and result.status != "success":
            log.info("delegate %s -> %s", skill.name, target)
            ctx.progress(target, by_name[target].progress_text)
            ctx.reason(f"'{skill.name}' could not map this to a device command, so I'm reasoning about what you want instead.", "agent")
            try:
                result = await by_name[target].run(ctx, request)
                skill = by_name[target]
            except LLMError as exc:
                log.error("skill %s failed: %s", target, exc)
        return skill, result

    def _offer_routine(self, skill: Skill, result: SkillResult, by_name: dict[str, Skill]) -> None:
        """After a change of several things at once, offer to keep it as a routine (saved on the next turn)."""
        if skill.name in {"device_control", "smart_control"} and result.status == "success" and "routines" in by_name:
            steps = sum(len((r.get("command_generated") or {}).get("commands", [])) for r in result.data.get("results", []) if r.get("status") == "success")
            if steps >= 2:
                result.message += SAVE_OFFER
                result.data["save_offer"] = True

    async def _run_plan(self, ctx: TurnContext, route, by_name: dict[str, Skill]) -> SkillResult:
        """Several tasks in one message: show the to-do list, then work through it (in order, or all at once when
        they are independent), ticking each off. A later task sees what earlier ones changed, so "dim the lights
        and save it as a routine" saves exactly that."""
        tasks = [t for t in route.tasks if t.skill in by_name]
        todo = [{"id": i + 1, "title": t.request, "skill": t.skill, "status": "pending"} for i, t in enumerate(tasks)]
        ctx.emit("plan", {"tasks": todo, "parallel": route.parallel})
        ctx.reason("Plan: " + "; ".join(f"{i + 1}) {t.request}" for i, t in enumerate(tasks))
                   + (". They are independent, so I'll do them at the same time." if route.parallel else ". I'll do them one by one, in this order."), "plan")
        done: list[tuple[int, Skill, SkillResult]] = []

        async def one(i: int, t) -> tuple[int, Skill, SkillResult]:
            ctx.emit("task", {"id": i + 1, "status": "running"})
            sub = replace(ctx, message=t.request, history=[], extras=dict(ctx.extras))
            skill, res = await self._run_one(sub, by_name[t.skill], t.request, by_name)
            status = task_state(res)
            ctx.emit("task", {"id": i + 1, "status": status, "summary": res.message.split("\n")[0][:200]})
            return i, skill, res

        if route.parallel:
            done = list(await asyncio.gather(*(one(i, t) for i, t in enumerate(tasks))))
        else:
            for i, t in enumerate(tasks):
                r = await one(i, t)
                done.append(r)
                # what this task changed is "what was just done" for the next one (e.g. save it as a routine)
                changed = [{"device_id": x["device_id"], "device_name": x.get("device_name"), "commands": x["command_generated"]["commands"]}
                           for x in r[2].data.get("results", []) if x.get("status") == "success" and (x.get("command_generated") or {}).get("commands")]
                if changed:
                    ctx.extras["last_actions"] = changed

        # one combined answer, and everything the UI shows (changes, sources, 3D, cards) from all tasks
        mark = {"done": "✓", "needs_input": "?", "failed": "✕"}
        parts = [f"{i + 1}. {mark[task_state(res)]} **{tasks[i].request}**\n{res.message.strip()}" for i, _skill, res in sorted(done, key=lambda x: x[0])]
        data: dict[str, Any] = {"skill": "plan", "request": ctx.message, "tasks": [
            {"id": i + 1, "skill": sk.name, "request": tasks[i].request, "status": res.status} for i, sk, res in sorted(done, key=lambda x: x[0])]}
        for key in ("results", "sources", "ui", "states", "suggestions"):
            merged = [x for _i, _s, res in sorted(done, key=lambda x: x[0]) for x in (res.data.get(key) or [])]
            if merged:
                data[key] = merged
        cards = [res.data["card"] for _i, _s, res in done if res.data.get("card")]
        if cards:
            data["card"] = cards[0]
        if any(res.data.get("llm_unavailable") for *_x, res in done):
            data["llm_unavailable"] = True
        finished = [res for *_x, res in done if task_state(res) == "done"]
        status = "success" if any(res.status == "success" for *_x, res in done) else "clarify" if finished or any(r.status == "clarify" for *_x, r in done) else "error"
        head = f"Done {len(finished)} of {len(tasks)} tasks." if finished else f"I couldn't finish any of the {len(tasks)} tasks."
        result = SkillResult(status, head + "\n\n" + "\n\n".join(parts), data)
        changed_steps = sum(len((r.get("command_generated") or {}).get("commands", [])) for r in data.get("results", []) if r.get("status") == "success")
        saved = any(res.data.get("routine_saved") for *_x, res in done)
        if changed_steps >= 2 and not saved and "routines" in by_name:
            result.message += SAVE_OFFER
            result.data["save_offer"] = True
        return result
