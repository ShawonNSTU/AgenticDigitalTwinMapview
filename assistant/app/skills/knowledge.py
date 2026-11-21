"""Skill: answer ANY question about the building from the twin's knowledge graph (RAG).

The twin builds the graph from the floor plan (rooms, sizes, neighbours, furniture, entrances), the devices (real
SmartThings or simulated, live state, what each can do), guests, alerts, maintenance, routines and the journal of
everything done on the website since the plan was loaded (who changed what, when; what a real device reported).
Each turn: fetch the documents for the asker's scope -> rank them (keywords + embeddings) -> the model answers ONLY
from the numbered facts it got, cites them, and suggests follow-ups. Counts come from the floor overview, so
"how many rooms are on this floor?" is always answerable.
"""
from __future__ import annotations

import logging
from typing import Any

from app.core.context import TurnContext
from app.core.skill import Skill, SkillResult, register
from app.integrations.twin import TwinClient
from app.knowledge.retriever import Embedder, retrieve

log = logging.getLogger("agent.knowledge")

SYSTEM = """You are {bot}, the assistant of a smart building ({who}). Answer the user's question using ONLY these facts.

Facts:
{facts}

Rules:
1. Use only the facts above. Quote numbers exactly as stated. For "how many", use the counts the facts give; when you list items, list all of them.
2. If the facts do not contain the answer, say so plainly and say what you do know that is closest.
3. "sources" = the numbers of the facts you used.
4. "follow_ups" = 2 short questions or requests the user might ask next (about this building, things you can do).
5. Be direct: lead with the answer in one sentence. Format for reading: short paragraphs; a "- " bullet list when you list 3 or more things (one per line); **bold** for the key number or name. No headings, no tables. At most about 120 words. Use names, not ids, unless an id helps.

Reply with JSON only: {{"reply": "<answer>", "sources": [<fact numbers>], "follow_ups": ["...", "..."]}}"""


@register
class KnowledgeSkill(Skill):
    name = "knowledge"
    progress_text = "Searching what I know"
    description = ("Any question about the building, floor plan and what happened: how many / which rooms, room sizes and neighbours, "
                   "what is in a room, devices (where, how many, real or simulated, what they can do, state), guests, alerts, routines, history (who did what, when).")
    examples = ["how many rooms are on this floor?", "what is in the gym room?", "who turned on Light 3?", "what happened today?"]
    capability = "answer questions about the floor, its rooms, devices and everything that happened"

    def __init__(self, llm, settings, twin: TwinClient | None = None):
        super().__init__(llm, settings)
        self.twin = twin or TwinClient(settings)
        self.embedder = Embedder(getattr(llm, "_client", None), settings.ollama_embed_model)

    def is_available(self, ctx: TurnContext) -> bool:
        return bool(ctx.extras.get("role"))          # the knowledge graph lives in the twin

    async def run(self, ctx: TurnContext, request: str) -> SkillResult:
        kg = await self.twin.kg(ctx.bearer_token)
        if not kg.ok:
            return SkillResult("error", "I can't reach what I know about the building right now. Please try again in a moment.", {"error": kg.error})
        docs: list[dict[str, Any]] = kg.data.get("docs", [])
        hits = await retrieve(f"{request}\n{ctx.message}", docs, self.embedder, k=self.settings.rag_top_k, max_chars=self.settings.rag_max_chars)
        if not hits:
            return SkillResult("clarify", "I don't know anything about this building yet. Load a floor plan first.")
        n = len(hits)
        facts = "\n".join(f"[{i + 1}] {h.doc.get('title', '')}: {h.doc.get('text', '')}" for i, h in enumerate(hits))
        schema = {"type": "object", "properties": {
            "reply": {"type": "string"},
            "sources": {"type": "array", "items": {"type": "integer", "enum": list(range(1, n + 1))}},
            "follow_ups": {"type": "array", "items": {"type": "string"}}}, "required": ["reply", "sources", "follow_ups"]}
        ctx.progress("knowledge", f"Read {n} facts")
        who = "staff view of the whole building" if ctx.is_staff else "a guest: only their room and the floor's public facts"
        out = await self.llm.complete_json(system=SYSTEM.format(bot=self.settings.bot_name, who=who, facts=facts),
                                           user=f"Question: {request}", schema=schema, label="knowledge")
        cited = [hits[i - 1].doc for i in dict.fromkeys(out.get("sources") or []) if 1 <= i <= n]
        sources = [{"id": d["id"], "kind": d.get("kind", ""), "title": d.get("title", ""), "devices": (d.get("devices") or [])[:20]} for d in cited]
        dev_ids = [x for d in cited if d.get("kind") in {"device", "alert"} for x in (d.get("devices") or [])]
        data: dict[str, Any] = {"sources": sources, "suggestions": [s.strip() for s in (out.get("follow_ups") or []) if s.strip()][:3],
                                "retrieved": [{"id": h.doc["id"], "why": h.why} for h in hits], "kg_version": kg.data.get("version")}
        if dev_ids:
            dev_ids = list(dict.fromkeys(dev_ids))[:30]
            data["ui"] = [{"type": "highlight", "ids": dev_ids}] + ([{"type": "focusDevice", "id": dev_ids[0]}] if len(dev_ids) == 1 else [])
        return SkillResult("clarify", out["reply"].strip() or "I don't have that information.", data)
