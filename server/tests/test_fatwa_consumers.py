"""The list, search, reader, Learn and library-summary consumers expose exactly what the strict validator serves."""
import json
import re
from pathlib import Path

import pytest

from balligh import fatwa_translation as ft

CONTENT = Path(__file__).resolve().parents[2] / "content"
ROOT = CONTENT / "translations" / "fatwa"
RECORDS = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted((CONTENT / "library/fatwa/records").glob("*.json"))}


def served(rid: str, loc: str) -> bool:
    return ft.valid_artifact(ROOT, RECORDS[rid], loc) is not None


def test_library_summary_counts_valid_sidecars_per_language(client):
    fatwa = client.get("/api/library").json()["collections"]["fatwa"]
    assert fatwa["machine_translations"] == {loc: sum(served(r, loc) for r in RECORDS) for loc in ft.LOCALES}
    assert fatwa["count"] == len(RECORDS) and fatwa["locales"]["ar"] == len(RECORDS)


def test_list_marks_translated_items_and_uses_the_sidecar_title(client):
    items = client.get("/api/library/fatwas", params={"locale": "en", "page_size": 50}).json()["items"]
    assert items
    for item in items:
        title = ft.sidecar_title(ROOT, RECORDS[item["id"]], "en")
        assert item["machine_translated"] == (title is not None)
        if title is not None:
            assert item["translated_title"] == title
    arabic = client.get("/api/library/fatwas", params={"locale": "ar", "page_size": 5}).json()["items"]
    assert arabic and all("machine_translated" not in item for item in arabic)


def test_search_finds_a_fatwa_by_its_translated_title(client):
    hit = next(((r, t) for r in RECORDS if (t := ft.sidecar_title(ROOT, RECORDS[r], "en"))), None)
    if hit is None:
        pytest.skip("no English sidecar in this tree")
    rid, title = hit
    word = max(re.findall(r"[A-Za-z]{4,}", title), key=len)
    found: list[str] = []
    page = 1
    while True:
        data = client.get("/api/library/fatwas", params={"locale": "en", "q": word, "page": page, "page_size": 50}).json()
        found += [item["id"] for item in data["items"]]
        if len(found) >= data["total"] or not data["items"]:
            break
        page += 1
    assert rid in found


def test_reader_reports_the_languages_that_are_actually_served(client):
    for rid in list(RECORDS)[:15]:
        data = client.get(f"/api/library/fatwas/{rid}", params={"locale": "en"}).json()
        assert data["machine_locales"] == [loc for loc in ft.LOCALES if served(rid, loc)]
        assert (data["machine_translation"] is not None) == served(rid, "en")
        assert data["record"]["content_sha256"] == RECORDS[rid]["content_sha256"]


def test_learn_entries_carry_actual_machine_availability_and_titles(client):
    stages = client.get("/api/learn/stages").json()["stages"]
    fatwas = [e for s in stages for e in s["entries"] if e.get("collection") == "fatwa"]
    assert fatwas
    for e in fatwas:
        rid = e["source_id"]
        assert e["machine_languages"] == [loc for loc in ft.LOCALES if served(rid, loc)]
        assert e["translated_titles"] == {loc: ft.sidecar_title(ROOT, RECORDS[rid], loc) for loc in e["machine_languages"]}
        assert e["languages"] == ["ar"]
