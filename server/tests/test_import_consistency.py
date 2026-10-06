import copy
import json
from pathlib import Path

import pytest

from balligh.schemas import LessonDraft
from balligh.sources import Registry, load_registry, validate_draft
from helpers import CONTENT

LIVE_EXPORT = Path(__file__).parent / "fixtures" / "live" / "g2-live-export-en-f034a415.json"
ZEROS = "0" * 64
LOCAL_NOTE = "src-g1-local-note-ar"


@pytest.fixture
def live_export() -> dict:
    return json.loads(LIVE_EXPORT.read_text(encoding="utf-8"))


def post_import(client, envelope: dict):
    return client.post("/api/drafts/import", content=json.dumps(envelope, ensure_ascii=False).encode("utf-8"))


def registry_with_non_test_source() -> Registry:
    registry = load_registry(CONTENT)
    real = registry.sources[LOCAL_NOTE].model_copy(update={"id": "src-real-x", "is_test_data": False})
    return Registry(
        sources={**registry.sources, real.id: real},
        texts={**registry.texts, real.id: registry.texts[LOCAL_NOTE]},
    )


def declare_manual(draft: dict) -> dict:
    draft["generation"] = {"origin": "manual"}
    for card in draft["cards"]:
        card["derivation"] = "team_translation" if card["kind"] == "quote" else "derived_explanation"
    return draft


def test_delivered_live_export_imports_as_unacknowledged_draft(client, live_export):
    r = post_import(client, live_export)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["valid"] is True and body["status"] == "draft"
    assert "local_review" in body["discarded_claims"]
    generation = body["draft"]["generation"]
    assert generation["origin"] == "live" and generation["human_edited"] is True
    assert generation["request_id"].startswith("f034a415")


@pytest.mark.parametrize(
    "tamper, message",
    [
        (lambda d: d.update(is_test_data=False), "is_test_data must be true"),
        (lambda d: d.update(input_hash=ZEROS), "input_hash does not match the registered source hash"),
        (lambda d: d["generation"].update(source_sha256=ZEROS), "generation.source_sha256 does not match"),
    ],
    ids=["test-flag-false", "input-hash-zeros", "generation-source-hash-zeros"],
)
def test_tampered_live_export_is_rejected_everywhere(client, live_export, tamper, message):
    tamper(live_export["draft"])
    r = post_import(client, live_export)
    assert r.status_code == 422, r.text
    assert any(message in e for e in r.json()["detail"]["errors"])
    draft = live_export["draft"]
    evaluation = client.post("/api/drafts/validate", json={"draft": draft}).json()
    assert evaluation["valid"] is False and evaluation["status"] == "needs_correction"
    ack = client.post(
        "/api/reviews/acknowledge",
        json={"draft": draft, "reviewer_label": "Technical test", "confirmed_compared_with_source": True},
    )
    assert ack.status_code == 422
    assert client.post("/api/export/html", json={"draft": draft}).status_code == 422


def test_fixture_export_cannot_drop_its_test_status(client, draft):
    draft["is_test_data"] = False
    r = post_import(client, {"format": "balligh.export/1", "draft": draft})
    assert r.status_code == 422
    assert any("is_test_data must be true" in e for e in r.json()["detail"]["errors"])


def test_any_registered_test_source_makes_the_whole_draft_test_data(draft):
    registry = registry_with_non_test_source()
    mixed = LessonDraft.model_validate({**draft, "source_ids": [*draft["source_ids"], "src-real-x"]})
    assert validate_draft(mixed, registry) == []
    unlabelled = mixed.model_copy(update={"is_test_data": False})
    assert any("is_test_data must be true" in e for e in validate_draft(unlabelled, registry))


def test_drafts_over_non_test_sources_may_still_be_marked_as_test_data(draft):
    registry = registry_with_non_test_source()
    moved = json.loads(json.dumps(draft).replace(LOCAL_NOTE, "src-real-x"))
    for flag in (True, False):
        assert validate_draft(LessonDraft.model_validate({**moved, "is_test_data": flag}), registry) == []


def test_a_live_draft_must_use_exactly_one_source(live_export):
    live = live_export["draft"]
    live["source_ids"].append("src-real-x")
    errors = validate_draft(LessonDraft.model_validate(live), registry_with_non_test_source())
    assert "a live AI draft must use exactly one registered source" in errors


def test_old_manual_and_fixture_formats_still_import(client, draft):
    assert post_import(client, {"format": "balligh.export/1", "draft": draft}).status_code == 200
    manual = copy.deepcopy(draft)
    manual["generation"] = {"origin": "manual", "note": "Edited by hand after the G1 fixture."}
    r = post_import(client, {"format": "balligh.export/1", "draft": manual})
    assert r.status_code == 200 and r.json()["valid"] is True and r.json()["status"] == "draft"


@pytest.mark.parametrize("declared", [{"origin": "fixture"}, {"origin": "manual", "note": "Edited by hand."}])
def test_declared_origin_is_not_presented_as_fact_in_html(client, draft, declared):
    draft["generation"] = declared
    html = client.post("/api/export/html", json={"draft": draft}).text
    assert "no AI model" not in html and "Edited by a person" not in html
    assert f"Declared origin: {declared['origin']}" in html
    assert "does not show whether an AI model was used" in html


def test_manual_declaration_replacing_live_metadata_gets_no_authorship_claim(client, live_export):
    declare_manual(live_export["draft"])
    r = post_import(client, live_export)
    assert r.status_code == 200, r.text
    imported = r.json()["draft"]
    assert imported["generation"]["origin"] == "manual"
    html = client.post("/api/export/html", json={"draft": imported}).text
    assert "no AI model" not in html
    assert "Declared origin: manual" in html
    assert "<strong>Test data.</strong>" in html


def test_live_export_keeps_ai_notice_and_technical_provenance(client, live_export):
    imported = post_import(client, live_export).json()["draft"]
    html = client.post("/api/export/html", json={"draft": imported}).text
    assert "<strong>AI draft.</strong>" in html and "<strong>Test data.</strong>" in html
    assert "deepseek-v4-pro" in html and imported["generation"]["request_id"] in html
    assert "Machine translation (AI draft, not reviewed by a person)" in html
    assert "AI-generated explanation (not reviewed by a person)" in html


def test_review_rules_hold_for_a_declared_manual_import(client, live_export):
    declare_manual(live_export["draft"])
    imported = post_import(client, live_export).json()["draft"]
    review = client.post(
        "/api/reviews/acknowledge",
        json={"draft": imported, "reviewer_label": "Technical test", "confirmed_compared_with_source": True},
    ).json()["review"]
    edited = copy.deepcopy(imported)
    edited["cards"][0]["text"] += " (changed)"
    status = client.post("/api/drafts/validate", json={"draft": edited, "review": review}).json()["status"]
    assert status == "stale"
    resized = copy.deepcopy(imported)
    resized["presentation"]["font_scale"] = 1.5
    status = client.post("/api/drafts/validate", json={"draft": resized, "review": review}).json()["status"]
    assert status == "acknowledged_by_user"
