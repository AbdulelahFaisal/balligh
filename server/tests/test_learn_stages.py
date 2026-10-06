import copy
import json

import pytest
from fastapi.testclient import TestClient

from balligh.api import create_app
from balligh.routes_learn import NOT_BEGINNER, ManifestError, install, load_stages, validate_stages
from helpers import CONTENT, offline_settings

STAGES = CONTENT / "learn" / "stages.json"
FLAGGED = {f"binbaz-{n}" for n in (15, 1614, 2002, 2348, 2631, 2778, 3442, 3446, 3709, 5627, 6782, 9614)}
TRANSLATED = ["ar", "en", "ur", "zh-Hans", "id", "bn", "fr"]


@pytest.fixture(scope="module")
def app():
    return install(create_app(offline_settings()))


@pytest.fixture(scope="module")
def client(app) -> TestClient:
    return TestClient(app)


@pytest.fixture(scope="module")
def library(app):
    return app.state.library


@pytest.fixture
def stages() -> dict:
    return copy.deepcopy(json.loads(STAGES.read_text(encoding="utf-8")))


def rejects(data: dict, library, fragment: str) -> None:
    with pytest.raises(ManifestError) as e:
        validate_stages(data, library)
    assert fragment in str(e.value)


def test_endpoint_serves_five_validated_stages(client):
    res = client.get("/api/learn/stages")
    assert res.status_code == 200
    body = res.json()
    assert body["schema"] == "balligh.learn.stages.v1"
    assert [s["order"] for s in body["stages"]] == [1, 2, 3, 4, 5]
    entries = [e for s in body["stages"] for e in s["entries"]]
    assert len(entries) == 17 == body["entry_count"]
    assert len({(e["collection"], e["source_id"]) for e in entries}) == 16 == body["distinct_count"]
    assert all(e["title"] and len(e["content_sha256"]) == 64 for e in entries)
    assert all(e["languages"] == ["ar"] for e in entries if e["collection"] == "fatwa")
    assert all(e["languages"] == TRANSLATED for e in entries if e["collection"] == "hadith")
    assert len(body["identity"]) == 64
    hrefs = {e["source_id"]: e["href"] for e in entries}
    assert hrefs["112"] == "/library/quran/112"
    assert hrefs["binbaz-854"] == "/library/questions/binbaz-854"
    assert hrefs["hadeethenc-4717"] == "/library/hadith/hadeethenc-4717"


def test_recap_entry_is_marked_and_points_to_an_earlier_stage(client):
    body = client.get("/api/learn/stages").json()
    recaps = [(s["order"], e["source_id"]) for s in body["stages"] for e in s["entries"] if e["recap"]]
    assert recaps == [(4, "hadeethenc-65000")]
    stage2 = [e["source_id"] for e in body["stages"][1]["entries"]]
    assert "hadeethenc-65000" in stage2


def test_human_support_and_not_covered_are_exact(client):
    body = client.get("/api/learn/stages").json()
    assert body["human_support"] == {
        "name": "eDialogue",
        "operator_ar": "جمعية ركن الحوار",
        "url": "https://edialogue.org/",
        "faq_url": "https://edialogue.org/faq/",
    }
    assert body["not_covered"] == ["prayer_demonstration", "fasting_rules", "zakah_calculation", "hajj_practice"]
    assert "edialoguec.org.sa" not in json.dumps(body)


def test_real_file_validates_directly(library):
    assert load_stages(STAGES, library)["distinct_count"] == 16


def test_unknown_record_id_is_rejected(stages, library):
    stages["stages"][0]["entries"][1]["source_id"] = "binbaz-999999999"
    rejects(stages, library, "not in the library index")


def test_unknown_surah_is_rejected(stages, library):
    stages["stages"][0]["entries"][0]["source_id"] = "115"
    rejects(stages, library, "not in the delivered Quran range")


def test_unmarked_repeat_is_rejected(stages, library):
    stages["stages"][3]["entries"][0]["recap"] = False
    rejects(stages, library, "repeated without being marked as a recap")


def test_recap_without_earlier_entry_is_rejected(stages, library):
    stages["stages"][0]["entries"][0]["recap"] = True
    rejects(stages, library, "a recap must repeat an earlier entry")


def test_flagged_ids_match_the_audit_and_are_rejected(stages, library):
    audit = json.loads((CONTENT.parent / "server" / "tests" / "fixtures" / "g4b" / "ALL_100_FATWA_AUDIENCE_REVIEW.json").read_text(encoding="utf-8"))
    labels = {r["id"]: r.get("recommended_level") or r.get("actual_fit") for r in audit["records"]}
    assert all(labels[i] == "teacher_context" for i in FLAGGED)
    assert FLAGGED <= NOT_BEGINNER
    for source_id in sorted(FLAGGED):
        data = copy.deepcopy(stages)
        data["stages"][4]["entries"][2]["source_id"] = source_id
        rejects(data, library, "not a beginner recommendation")


def test_changed_support_link_is_rejected(stages, library):
    stages["human_support"]["url"] = "https://edialoguec.org.sa/programs/5"
    rejects(stages, library, "eDialogue")


def test_missing_stage_and_unknown_field_are_rejected(stages, library):
    data = copy.deepcopy(stages)
    data["stages"].pop()
    rejects(data, library, "must have 5 stages")
    stages["stages"][0]["entries"][0]["translation"] = "invented"
    rejects(stages, library, "unexpected fields")


def test_first_steps_manifest_is_unchanged(client):
    res = client.get("/api/learn")
    assert res.status_code == 200
    assert res.json()["schema"] == "balligh.learn.v1"
