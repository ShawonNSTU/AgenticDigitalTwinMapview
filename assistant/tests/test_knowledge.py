"""RAG over the twin's knowledge graph: ranking, the overview always present, embeddings optional, grounded answers."""
from __future__ import annotations

from app.core.agent import Agent
from app.integrations.twin import TwinResult
from app.knowledge.retriever import BM25, Embedder, retrieve, tokens
from app.normalize import build_context
from tests.conftest import FakeLLM, sample_request

DOCS = [
    {"id": "floor:summary", "kind": "summary", "title": "4th floor: overview", "text": "It has 29 rooms: Gym Room; Cafeteria; SmartThings Experience Zone. 28 devices in total."},
    {"id": "room:gym-room", "kind": "room", "title": "Gym Room", "text": "Gym Room is a room. Size 6 m x 4 m (24 m²). Furniture: 3 treadmill, 2 bike.", "rooms": ["gym-room"]},
    {"id": "device:LT-03", "kind": "device", "title": "Light 3 · SmartThings Experience Zone", "text": "Light 3 (LT-03) is a smart light. REAL SmartThings device. Now: on at 80%.", "devices": ["LT-03"]},
    {"id": "device:AC-02", "kind": "device", "title": "Air conditioner · Gym Room", "text": "Simulated air conditioner. Now: on, set to 24 °C.", "devices": ["AC-02"]},
    {"id": "events:0", "kind": "history", "title": "What happened 21 Nov 17:00 – 17:30", "text": "21 Nov 17:20 · Light 3 (LT-03): power (on true) done (by Administrator).", "devices": ["LT-03"]},
]


def test_tokens_stem_and_drop_stopwords():
    assert tokens("How many treadmills are in the gym rooms?") == ["treadmill", "gym", "room"]


def test_bm25_ranks_the_named_thing_first():
    rest = DOCS[1:]
    order = [rest[i]["id"] for i, _ in BM25(rest).rank("treadmill in the gym")]
    assert order[0] == "room:gym-room"
    assert [rest[i]["id"] for i, _ in BM25(rest).rank("who switched on light 3")][:2] == ["device:LT-03", "events:0"] or \
           [rest[i]["id"] for i, _ in BM25(rest).rank("who switched on light 3")][0] in {"device:LT-03", "events:0"}


async def test_overview_is_always_included_and_first():
    hits = await retrieve("how many rooms are there", DOCS, None, k=2)
    assert hits[0].doc["id"] == "floor:summary" and len(hits) <= 3


class FakeEmbedClient:
    def __init__(self, fail=False):
        self.fail, self.calls = fail, 0

    async def embed(self, model, input):
        self.calls += 1
        if self.fail:
            raise RuntimeError("model not found")
        # meaning: "cooling" is close to the air conditioner document
        return {"embeddings": [[1.0, 0.0] if ("cool" in t.lower() or "air conditioner" in t.lower()) else [0.0, 1.0] for t in input]}


async def test_embeddings_add_meaning_and_are_cached():
    client = FakeEmbedClient()
    emb = Embedder(client, "nomic-embed-text")
    hits = await retrieve("is the cooling running", DOCS, emb, k=1)
    assert hits[1].doc["id"] == "device:AC-02" and "meaning" in hits[1].why
    before = len(emb.cache)
    await retrieve("is the cooling running", DOCS, emb, k=1)
    assert len(emb.cache) == before                                     # documents are not embedded twice


async def test_embedding_failure_falls_back_to_keywords():
    emb = Embedder(FakeEmbedClient(fail=True), "nomic-embed-text")
    hits = await retrieve("treadmill", DOCS, emb, k=1)
    assert hits[1].doc["id"] == "room:gym-room"
    assert await emb.embed(["x"]) is None                               # stays off for a while, no repeated waits


class KgTwin:
    async def kg(self, token):
        return TwinResult(True, {"version": "1", "docs": DOCS})


async def ask(settings, script, text, role="admin"):
    llm = FakeLLM(script)
    agent = Agent(llm, settings)
    for s in agent.skills:
        if s.name == "knowledge":
            s.twin = KgTwin()
    res = await agent.handle(build_context(sample_request(text, extras={"role": role}), "tok", settings))
    return res, llm


async def test_how_many_rooms_is_answered_from_the_overview(settings):
    res, llm = await ask(settings, {"router": [{"skill": "knowledge", "request": "how many rooms are on this floor?"}],
                                    "knowledge": [lambda s, u: {"reply": "29 rooms." if "29 rooms" in s else "unknown", "sources": [1], "follow_ups": ["Which rooms have devices?"]}]},
                         "How many rooms in current floor")
    assert res.message == "29 rooms." and res.data["sources"][0]["id"] == "floor:summary"
    assert res.data["suggestions"] == ["Which rooms have devices?"]


async def test_answer_cites_and_highlights_devices(settings):
    res, llm = await ask(settings, {"router": [{"skill": "knowledge", "request": "who turned on Light 3?"}],
                                    "knowledge": [lambda s, u: {"reply": "The administrator, at 17:20.", "sources": [int(l[1]) for l in s.splitlines() if l.startswith("[") and "17:20" in l], "follow_ups": []}]},
                         "who turned on light 3?")
    assert "administrator" in res.message.lower()
    assert res.data["sources"][0]["kind"] == "history"
    enum = llm.calls[-1]["schema"]["properties"]["sources"]["items"]["enum"]
    assert enum == list(range(1, len(enum) + 1))                       # the model can only cite facts it was given


async def test_questions_fall_back_to_knowledge_and_old_skills_step_aside(settings):
    res, llm = await ask(settings, {"router": [{"skill": "knowledge", "request": "x"}], "knowledge": [{"reply": "ok", "sources": [], "follow_ups": []}]}, "x", role="guest")
    router = llm.calls[0]["system"]
    assert "- knowledge" in router and "- rooms:" not in router and "- device_info" not in router
    assert 'choose "knowledge"' in router


async def test_where_is_a_device_focuses_it_in_3d(settings):
    res, _ = await ask(settings, {"router": [{"skill": "knowledge", "request": "where is the Desk Lamp?"}],
                                  "knowledge": [{"reply": "On the desk in the SmartThings Experience Zone.", "sources": [1], "follow_ups": []}]}, "where is the Desk Lamp?")
    ui = res.data["ui"]
    assert ui[0]["type"] == "highlight" and ui[1]["type"] == "focusDevice" and ui[1]["id"] == ui[0]["ids"][0]


async def test_room_question_turns_the_view_to_the_room(settings):
    res, _ = await ask(settings, {"router": [{"skill": "knowledge", "request": "show me the gym room"}],
                                  "knowledge": [lambda s, u: {"reply": "Here it is.", "sources": [next(int(l[1]) for l in s.splitlines() if l.startswith("[") and "Gym Room:" in l)], "follow_ups": []}]}, "show me the gym room")
    assert {"type": "selectRoom", "room": "gym-room"} in res.data["ui"]
