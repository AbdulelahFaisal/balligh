import json

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from balligh.api import create_app
from balligh.schemas import LessonDraft
from helpers import RecordingSleep, ScriptedDeepSeek, keyed_settings, lesson_reply, request_body


@pytest.fixture
def generated():
    scripted = ScriptedDeepSeek(lesson_reply())
    app = TestClient(create_app(keyed_settings(), transport=scripted.transport(), sleep=RecordingSleep()))
    return app, app.post("/api/drafts/generate", json=request_body()).json()["draft"]


def test_g1_fixture_export_still_imports(client, draft):
    exported = client.post("/api/export/json", json={"draft": draft}).json()
    r = client.post("/api/drafts/import", content=json.dumps(exported, ensure_ascii=False).encode("utf-8"))
    assert r.status_code == 200
    assert r.json()["draft"]["generation"]["origin"] == "fixture"


def test_p1_era_hand_edited_draft_still_validates(client, draft):
    draft["generation"] = {"origin": "manual", "note": "Edited by hand after the G1 fixture."}
    r = client.post("/api/drafts/validate", json={"draft": draft})
    assert r.status_code == 200 and r.json()["valid"] is True


def test_human_edit_keeps_live_provenance_and_invalidates_review(generated):
    app, draft = generated
    ack = app.post(
        "/api/reviews/acknowledge",
        json={"draft": draft, "reviewer_label": "Technical test", "confirmed_compared_with_source": True},
    ).json()
    edited = json.loads(json.dumps(draft))
    edited["cards"][0]["text"] += " (checked)"
    edited["generation"]["human_edited"] = True
    edited["generation"]["last_human_edit_at"] = "2026-10-06T02:00:00+03:00"
    status = app.post("/api/drafts/validate", json={"draft": edited, "review": ack["review"]}).json()["status"]
    assert status == "stale"
    model = LessonDraft.model_validate(edited)
    assert model.generation.origin == "live" and model.generation.human_edited is True
    assert model.generation.request_id == draft["generation"]["request_id"]
    resized = json.loads(json.dumps(draft))
    resized["presentation"]["font_scale"] = 1.5
    resized["generation"]["human_edited"] = True
    still = app.post("/api/drafts/validate", json={"draft": resized, "review": ack["review"]}).json()["status"]
    assert still == "acknowledged_by_user"


def test_live_drafts_cannot_be_relabelled_as_team_translation(generated):
    _, draft = generated
    draft["cards"][0]["derivation"] = "team_translation"
    with pytest.raises(ValidationError, match="machine derivation"):
        LessonDraft.model_validate(draft)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda g: g.update(provider="openai"),
        lambda g: g.update(request_id="not-a-uuid"),
        lambda g: g.update(usage={"prompt_tokens": "many"}),
        lambda g: g.update(review_status="approved"),
        lambda g: g.pop("generated_at"),
    ],
)
def test_live_metadata_is_strict(generated, mutate):
    _, draft = generated
    mutate(draft["generation"])
    with pytest.raises(ValidationError):
        LessonDraft.model_validate(draft)
