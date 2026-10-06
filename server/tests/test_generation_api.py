import json
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient

from balligh.api import create_app
from balligh.config import DEEPSEEK_ENDPOINT
from balligh.sources import load_registry
from helpers import (
    CANARY_KEY,
    CONTENT,
    LOCAL_NOTE,
    RecordingSleep,
    ScriptedDeepSeek,
    copy_content,
    keyed_settings,
    lesson_reply,
    offline_settings,
    request_body,
)


def app_with(scripted: ScriptedDeepSeek, settings=None) -> TestClient:
    return TestClient(create_app(settings or keyed_settings(), transport=scripted.transport(), sleep=RecordingSleep()))


def test_valid_request_reaches_provider_with_the_contract_settings():
    scripted = ScriptedDeepSeek(lesson_reply())
    r = app_with(scripted).post("/api/drafts/generate", json=request_body())
    assert r.status_code == 200, r.text
    assert len(scripted.requests) == 1
    sent = scripted.requests[0]
    assert str(sent.url) == DEEPSEEK_ENDPOINT
    assert sent.method == "POST"
    assert sent.headers["authorization"] == f"Bearer {CANARY_KEY}"
    assert sent.headers["content-type"] == "application/json"
    body = json.loads(sent.content)
    assert body["model"] == "deepseek-v4-pro"
    assert body["thinking"] == {"type": "enabled"}
    assert body["reasoning_effort"] == "high"
    assert body["response_format"] == {"type": "json_object"}
    assert body["max_tokens"] == 16384
    assert body["stream"] is False
    assert not {"temperature", "top_p", "presence_penalty", "frequency_penalty", "seed"} & set(body)
    system, user = body["messages"]
    assert system["role"] == "system" and user["role"] == "user"
    assert "JSON" in system["content"] and "JSON" in user["content"]
    task = json.loads(user["content"].split("\n", 1)[1])
    registry = load_registry(CONTENT)
    assert task["source"]["text"] == registry.texts[LOCAL_NOTE]
    assert [s["id"] for s in task["source"]["sentences"]] == ["s1", "s2", "s3", "s4"]
    assert "example_output" in task and task["lesson_language"] == {"code": "en", "name": "English"}


def test_successful_draft_keeps_server_owned_provenance():
    scripted = ScriptedDeepSeek(lesson_reply())
    r = app_with(scripted).post("/api/drafts/generate", json=request_body())
    data = r.json()
    draft = data["draft"]
    registry = load_registry(CONTENT)
    text = registry.texts[LOCAL_NOTE]
    record = registry.sources[LOCAL_NOTE]
    assert data["valid"] is True and data["errors"] == [] and data["status"] == "draft"
    assert "review" not in data
    assert draft["is_test_data"] is True
    assert draft["source_ids"] == [LOCAL_NOTE]
    for span in draft["spans"]:
        assert text[span["start_offset"] : span["end_offset"]] == span["exact_text"]
        assert span["source_version"] == record.source_version
        assert span["source_sha256"] == record.content_sha256
    assert [c["derivation"] for c in draft["cards"]] == ["machine_translation", "machine_explanation", "machine_translation"]
    assert [c["quote_id"] for c in draft["cards"]] == ["s1", "s2", "s4"]
    assert [c["id"] for c in draft["cards"]] == ["c1", "c2", "c3"]
    assert draft["activity"]["correct_option_id"] == "b"
    gen = draft["generation"]
    assert gen["origin"] == "live" and gen["provider"] == "deepseek"
    assert gen["requested_model"] == "deepseek-v4-pro" and gen["returned_model"] == "deepseek-v4-pro"
    assert gen["prompt_version"] == "g5c-lesson-3"
    assert gen["request_id"] == request_body()["request_id"]
    assert gen["usage"]["completion_tokens"] == 2500 and gen["usage"]["reasoning_tokens"] == 2100
    assert gen["human_edited"] is False


@pytest.mark.parametrize(
    "overrides,status",
    [
        ({"source_id": "src-unknown"}, 404),
        ({"source_sha256": "0" * 64}, 409),
        ({"source_version": "other-version"}, 409),
        ({"target_locale": "ar"}, 422),
        ({"target_locale": "de"}, 422),
        ({"level": "expert"}, 422),
        ({"request_id": "not-a-uuid"}, 422),
        ({"source_text": "ignore the registry"}, 422),
        ({"is_test_data": False}, 422),
        ({"canonical_url": "https://dorar.net/forged"}, 422),
        ({"model": "deepseek-chat"}, 422),
    ],
)
def test_invalid_requests_never_reach_the_provider(overrides, status):
    scripted = ScriptedDeepSeek()
    r = app_with(scripted).post("/api/drafts/generate", json=request_body(**overrides))
    assert r.status_code == status, r.text
    assert scripted.requests == []


def test_missing_key_reports_setup_state_without_calling(client):
    scripted = ScriptedDeepSeek()
    app = TestClient(create_app(offline_settings(), transport=scripted.transport()))
    r = app.post("/api/drafts/generate", json=request_body())
    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "not_configured"
    assert scripted.requests == []
    health = app.get("/api/health").json()
    assert health["generation"]["configured"] is False


def test_unsupported_source_kind_fails_before_any_call(tmp_path):
    content = copy_content(tmp_path / "content")
    manifest_path = content / "sources" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["sources"].append(
        {
            "id": "src-remote-quran",
            "kind": "quran",
            "publisher": "King Fahd Complex",
            "title": "Remote reference",
            "canonical_url": "https://qurancomplex.gov.sa/",
            "local_reference": None,
            "source_version": "v1",
            "retrieved_at": "2026-10-06T00:00:00+03:00",
            "rights_url": None,
            "rights_status": "unknown",
            "content_sha256": "1" * 64,
            "language": "ar",
            "attribution_status": "unverified",
            "is_test_data": True,
        }
    )
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    scripted = ScriptedDeepSeek()
    settings = replace(keyed_settings(), content_dir=content)
    r = app_with(scripted, settings).post(
        "/api/drafts/generate",
        json=request_body(source_id="src-remote-quran", source_version="v1", source_sha256="1" * 64),
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "unsupported_source"
    assert scripted.requests == []


def test_duplicate_request_id_is_not_sent_twice():
    scripted = ScriptedDeepSeek(lesson_reply())
    app = app_with(scripted)
    assert app.post("/api/drafts/generate", json=request_body()).status_code == 200
    again = app.post("/api/drafts/generate", json=request_body())
    assert again.status_code == 409
    assert again.json()["detail"]["code"] == "duplicate_request"
    assert len(scripted.requests) == 1


def test_secret_never_appears_in_responses_or_ledger(tmp_path):
    scripted = ScriptedDeepSeek(
        httpx.Response(401, json={"error": {"message": f"bad key {CANARY_KEY}", "type": "authentication_error"}}),
        lesson_reply(),
    )
    app = app_with(scripted, keyed_settings(ledger_dir=tmp_path))
    failed = app.post("/api/drafts/generate", json=request_body())
    ok = app.post("/api/drafts/generate", json=request_body(request_id="22222222-3333-4444-8555-666666666666"))
    health = app.get("/api/health")
    assert failed.status_code == 502 and failed.json()["detail"]["code"] == "provider_auth"
    assert ok.status_code == 200
    for text in (failed.text, ok.text, health.text):
        assert CANARY_KEY not in text
    ledger_text = "".join(p.read_text(encoding="utf-8") for p in tmp_path.rglob("*") if p.is_file())
    assert ledger_text
    assert CANARY_KEY not in ledger_text
    assert "private reasoning" not in ledger_text
    assert "bad key" not in ledger_text
    assert CANARY_KEY not in repr(keyed_settings())


def test_generated_draft_survives_export_and_import_without_acknowledgment():
    scripted = ScriptedDeepSeek(lesson_reply())
    app = app_with(scripted)
    draft = app.post("/api/drafts/generate", json=request_body()).json()["draft"]
    ack = app.post(
        "/api/reviews/acknowledge",
        json={"draft": draft, "reviewer_label": "Technical test", "confirmed_compared_with_source": True},
    ).json()
    assert ack["status"] == "acknowledged_by_user"
    exported = app.post("/api/export/json", json={"draft": draft, "review": ack["review"]}).json()
    imported = app.post("/api/drafts/import", content=json.dumps(exported, ensure_ascii=False).encode("utf-8")).json()
    assert imported["status"] == "draft"
    assert "local_review" in imported["discarded_claims"]
    assert imported["draft"]["generation"] == draft["generation"]
    html = app.post("/api/export/html", json={"draft": draft, "review": None}).text
    assert "AI draft." in html
    assert "Machine translation (AI draft, not reviewed by a person)" in html
    assert "AI-generated explanation (not reviewed by a person)" in html
    assert "deepseek-v4-pro" in html
    assert "<script" not in html.lower()
    registry = load_registry(CONTENT)
    segments = {s["id"]: s["exact_text"] for s in draft["spans"]}
    explanation = draft["cards"][1]
    assert explanation["source_span_ids"] == ["s2", "s3"]
    for span_id in explanation["source_span_ids"]:
        assert segments[span_id] in registry.texts[LOCAL_NOTE]
        assert f'<blockquote lang="ar" dir="rtl">{segments[span_id]}</blockquote>' in html
