"""Search eval set (evals/search_cases.json). Extend it whenever a demo question misbehaves."""
import json
from pathlib import Path
import pytest
from app.search import search

CASES = json.loads((Path(__file__).resolve().parents[1] / "evals" / "search_cases.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=[c["q"] for c in CASES])
def test_case(case, floor):
    res = search(case["q"], floor)
    got = [d["id"] for d in res["devices"]]
    if "ids" in case:
        assert sorted(got) == sorted(case["ids"])
    else:
        assert got, "expected matches"
    if "all_prefix" in case:
        assert all(i.startswith(case["all_prefix"]) for i in got)
    if "room" in case:
        assert all(d["room"] == case["room"] for d in res["devices"])
    if "types" in case:
        types = {d["type"] for d in floor["devices"] if d["id"] in got}
        assert types <= set(case["types"]) and types
