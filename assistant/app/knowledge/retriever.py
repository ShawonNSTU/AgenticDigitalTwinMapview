"""Retrieval over the twin's knowledge graph documents (GET {twin}/kg).

Hybrid ranking, no extra services needed:
  * BM25 over title + text (title counts double), with light stemming. Always on.
  * Dense: Ollama embeddings (OLLAMA_EMBED_MODEL, e.g. nomic-embed-text) when that model is available. Document
    vectors are cached by the hash of their text, so only changed facts are embedded again. If the model is missing
    or Ollama fails, retrieval quietly stays keyword-only.
The two rankings are merged with reciprocal rank fusion. The floor overview is always included: it carries every
count ("how many rooms / lights / guests"), which retrieval by similarity would otherwise miss.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import re
from collections import Counter, OrderedDict
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("agent.knowledge")

STOP = set("""a an the of in on at to for and or is are was were be been it its this that these those there here what which who whom
whose how many much do does did i me my we our you your they them he she his her with from by as into about any all can could
would should will shall may might please tell show give list me now currently current""".split())


def _stem(w: str) -> str:
    for suf in ("ings", "ing", "ies", "es", "ed", "s"):
        if len(w) > len(suf) + 2 and w.endswith(suf):
            return w[: -len(suf)] + ("y" if suf == "ies" else "")
    return w


def tokens(text: str) -> list[str]:
    return [_stem(w) for w in re.findall(r"[a-z0-9]+(?:-[0-9]+)?", text.lower()) if w not in STOP]


@dataclass
class Hit:
    doc: dict[str, Any]
    score: float
    why: list[str] = field(default_factory=list)


class BM25:
    def __init__(self, docs: list[dict[str, Any]], k1: float = 1.4, b: float = 0.7):
        self.docs, self.k1, self.b = docs, k1, b
        self.tf = [Counter(tokens(d.get("title", "")) * 2 + tokens(d.get("text", ""))) for d in docs]
        self.len = [sum(t.values()) for t in self.tf]
        self.avg = (sum(self.len) / len(self.len)) if self.len else 1.0
        df: Counter[str] = Counter()
        for t in self.tf:
            df.update(t.keys())
        n = len(docs)
        self.idf = {w: math.log(1 + (n - c + 0.5) / (c + 0.5)) for w, c in df.items()}

    def rank(self, query: str) -> list[tuple[int, float]]:
        q = tokens(query)
        out = []
        for i, tf in enumerate(self.tf):
            s = 0.0
            for w in q:
                f = tf.get(w)
                if f:
                    s += self.idf[w] * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * self.len[i] / self.avg))
            if s > 0:
                out.append((i, s))
        return sorted(out, key=lambda x: -x[1])


class Embedder:
    """Ollama embeddings with a text-hash cache. `ok` turns False after a failure (retried every 5 minutes)."""

    def __init__(self, client: Any, model: str, cache_size: int = 20000):
        self.client, self.model = client, model
        self.cache: OrderedDict[str, list[float]] = OrderedDict()
        self.cache_size = cache_size
        self.down_until = 0.0

    @property
    def enabled(self) -> bool:
        return bool(self.model and self.client)

    async def embed(self, texts: list[str]) -> list[list[float]] | None:
        loop = asyncio.get_running_loop()
        if not self.enabled or loop.time() < self.down_until:
            return None
        keys = [hashlib.sha1(t.encode()).hexdigest() for t in texts]
        todo = [(k, t) for k, t in zip(keys, texts) if k not in self.cache]
        try:
            for i in range(0, len(todo), 64):
                part = todo[i : i + 64]
                resp = await asyncio.wait_for(self.client.embed(model=self.model, input=[t for _, t in part]), timeout=30)
                vecs = getattr(resp, "embeddings", None) or (resp.get("embeddings") if isinstance(resp, dict) else None)
                if not vecs or len(vecs) != len(part):
                    raise RuntimeError("no embeddings returned")
                for (k, _), v in zip(part, vecs):
                    self.cache[k] = list(v)
        except Exception as exc:  # model not pulled, Ollama down: keyword-only for a while
            log.warning("embeddings unavailable (%s): keyword retrieval only", exc)
            self.down_until = loop.time() + 300
            return None
        while len(self.cache) > self.cache_size:
            self.cache.popitem(last=False)
        return [self.cache[k] for k in keys]


def _cos(a: list[float], b: list[float]) -> float:
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    return sum(x * y for x, y in zip(a, b)) / (na * nb)


def _doc_text(d: dict[str, Any]) -> str:
    return f"{d.get('title', '')}\n{d.get('text', '')}"


async def retrieve(query: str, docs: list[dict[str, Any]], embedder: Embedder | None, k: int = 8, max_chars: int = 7000) -> list[Hit]:
    """The overview plus the k best documents for the query, within a character budget."""
    if not docs:
        return []
    summary = [d for d in docs if d.get("kind") == "summary"]
    rest = [d for d in docs if d.get("kind") != "summary"]
    lexical = BM25(rest).rank(query) if rest else []
    fused: dict[int, float] = {}
    why: dict[int, list[str]] = {}
    for r, (i, _s) in enumerate(lexical[:50]):
        fused[i] = fused.get(i, 0) + 1 / (60 + r)
        why.setdefault(i, []).append("keywords")
    if embedder and embedder.enabled and rest:
        vecs = await embedder.embed([query] + [_doc_text(d) for d in rest])
        if vecs:
            q, dv = vecs[0], vecs[1:]
            dense = sorted(((i, _cos(q, v)) for i, v in enumerate(dv)), key=lambda x: -x[1])
            for r, (i, _s) in enumerate(dense[:50]):
                fused[i] = fused.get(i, 0) + 1 / (60 + r)
                why.setdefault(i, []).append("meaning")
    order = sorted(fused, key=lambda i: -fused[i])
    hits = [Hit(d, 1.0, ["overview"]) for d in summary]
    used = sum(len(h.doc.get("text", "")) for h in hits)
    for i in order:
        if len(hits) >= k + len(summary):
            break
        t = len(rest[i].get("text", ""))
        if used + t > max_chars and len(hits) > len(summary):
            continue
        hits.append(Hit(rest[i], fused[i], why.get(i, [])))
        used += t
    return hits
