import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from balligh.api import create_app
from balligh.library.catalog import Library
from helpers import CONTENT, offline_settings

ROOT = CONTENT / "library"
FATWA_RAW = Path(__file__).parent / "fixtures" / "library" / "fatwa" / "18975.html"
FOREIGN = ("en", "ur", "zh-Hans", "id", "bn", "fr")


@pytest.fixture(scope="module")
def c() -> TestClient:
    return TestClient(create_app(offline_settings()))


def test_snapshot_is_pinned_and_loads_cleanly():
    library = Library(ROOT)
    assert library.errors == {}
    catalog = json.loads((ROOT / "library.json").read_text(encoding="utf-8"))
    assert set(catalog["collections"]) == {"quran", "fatwa", "hadith"}


def test_quran_delivered_range_and_editions(c):
    overview = c.get("/api/library/quran").json()
    numbers = [s["number"] for s in overview["surahs"]]
    assert set(range(78, 115)) <= set(numbers)
    assert sum(s["ayah_count"] for s in overview["surahs"]) == overview["range"]["ayah_count"]
    assert sorted(e["locale"] for e in overview["editions"]) == sorted(FOREIGN)
    if overview["range"]["kind"] == "full":
        assert numbers == list(range(1, 115)) and overview["range"]["ayah_count"] == 6236
    last = c.get("/api/library/quran/114?locale=en").json()
    assert [a["aya"] for a in last["ayahs"]] == [1, 2, 3, 4, 5, 6] and last["next"] is None
    assert last["ayahs"][1]["footnotes"] == "[1] i.e., the King of mankind."
    assert last["ayahs"][1]["translation"] == "the Sovereign of mankind[1],"
    for loc in FOREIGN:
        body = c.get(f"/api/library/quran/{numbers[0]}?locale={loc}").json()
        assert body["translation_status"] == "available" and all(a["translation"] for a in body["ayahs"])


def test_fatwa_examples_keep_full_text_and_quotations(c):
    listing = c.get("/api/library/fatwas?page_size=50").json()
    assert listing["total"] >= 100
    body = c.get("/api/library/fatwas/binbaz-18975?locale=en").json()
    rec = body["record"]
    text = "".join(run["text"] for para in rec["question"] + rec["answer"] for run in para)
    assert "ما معنى (شهادة أن لا إله إلا الله وأن محمدًا رسول الله)؟" in text
    quran = [run["text"] for para in rec["answer"] for run in para if run["kind"] == "quran"]
    raw = FATWA_RAW.read_bytes().decode("utf-8")
    assert quran == re.findall(r'<span class="aaya">(.*?)</span>', raw) and quran[0].startswith("ذَلِكَ")
    assert "[الحج:62]" in text and text.rstrip().endswith("حفظكم الله.")
    assert body["translation_status"] in ("available", "unavailable")


def test_hadith_count_grades_and_translations(c):
    listing = c.get("/api/library/hadith?page_size=50").json()
    assert 100 <= listing["total"] <= 200
    first = listing["items"][0]["id"]
    body = c.get(f"/api/library/hadith/{first}?locale=zh-Hans").json()
    assert body["record"]["grade"] == "صحيح" and body["record"]["grading_authority"]
    assert body["record"]["dorar"]["status"] == "not_verified"
    if body["translation_status"] == "available":
        assert body["translation"]["source_language_code"] == "zh"


def test_legacy_lesson_sources_unchanged(c):
    sources = c.get("/api/sources").json()
    legacy = [s for s in sources if s["is_test_data"]]
    assert len(legacy) == 4 and all(s["kind"] == "local_text" for s in legacy)
    assert all(s["kind"] in ("fatwa", "hadith") and s["library_record_id"] for s in sources if not s["is_test_data"])
