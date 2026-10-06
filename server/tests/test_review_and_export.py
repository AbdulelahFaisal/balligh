import json
import re
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from balligh.api import create_app
from helpers import CONTENT, copy_content, keyed_settings


def ack(client, draft):
    r = client.post(
        "/api/reviews/acknowledge",
        json={"draft": draft, "reviewer_label": "Tester", "confirmed_compared_with_source": True},
    )
    assert r.status_code == 200, r.text
    return r.json()


def status_of(client, draft, review):
    return client.post("/api/drafts/validate", json={"draft": draft, "review": review}).json()["status"]


def test_ack_requires_confirmation(client, draft):
    r = client.post(
        "/api/reviews/acknowledge",
        json={"draft": draft, "reviewer_label": "Tester", "confirmed_compared_with_source": False},
    )
    assert r.status_code == 422


def test_ack_refused_for_invalid_draft(client, draft):
    draft["spans"][0]["start_offset"] += 1
    r = client.post(
        "/api/reviews/acknowledge",
        json={"draft": draft, "reviewer_label": "Tester", "confirmed_compared_with_source": True},
    )
    assert r.status_code == 422


def test_ack_record_is_honest(client, draft):
    res = ack(client, draft)
    rev = res["review"]
    assert res["status"] == "acknowledged_by_user"
    assert rev["status"] == "acknowledged_by_user"
    assert rev["verification"] == "none_local_self_declared"
    assert rev["lesson_hash"] == res["lesson_hash"]


SEMANTIC_EDITS = {
    "card_text": lambda d: d["cards"][0].__setitem__("text", d["cards"][0]["text"] + "!"),
    "editor_note": lambda d: d["cards"][1].__setitem__("editor_note", "check wording"),
    "title": lambda d: d.__setitem__("title", d["title"] + " (v2)"),
    "locale": lambda d: d.__setitem__("target_locale", "fr"),
    "level": lambda d: d.__setitem__("level", "detailed"),
    "glossary_version": lambda d: d.__setitem__("glossary_version", "g1-fixture-glossary-2"),
    "term_meaning": lambda d: d["terms"][0].__setitem__("meaning", "Something else."),
    "activity_question": lambda d: d["activity"].__setitem__("question", "Changed?"),
    "activity_answer": lambda d: d["activity"].__setitem__("correct_option_id", "a"),
    "card_spans": lambda d: d["cards"][1].__setitem__("source_span_ids", ["sp1"]),
    "derivation": lambda d: d["cards"][0].__setitem__("derivation", "derived_explanation"),
}


@pytest.mark.parametrize("name", SEMANTIC_EDITS)
def test_semantic_edit_invalidates_ack(client, draft, name):
    res = ack(client, draft)
    SEMANTIC_EDITS[name](draft)
    assert status_of(client, draft, res["review"]) in ("stale", "needs_correction")


def test_source_change_invalidates_ack(client, draft):
    res = ack(client, draft)
    draft["spans"][0]["source_version"] = "g1-fixture-2"
    assert status_of(client, draft, res["review"]) in ("stale", "needs_correction")
    review = dict(res["review"])
    draft2 = json.loads(json.dumps(draft))
    draft2["spans"][0]["source_version"] = "g1-fixture-1"
    assert status_of(client, draft2, review) == "acknowledged_by_user"


def test_presentation_change_keeps_ack(client, draft):
    res = ack(client, draft)
    draft["presentation"]["font_scale"] = 1.5
    draft["id"] = "renamed-copy"
    draft["generation"] = {"origin": "manual", "note": "touched"}
    assert status_of(client, draft, res["review"]) == "acknowledged_by_user"


def test_hash_is_stable_and_key_order_independent(client, draft):
    h1 = client.post("/api/drafts/validate", json={"draft": draft}).json()["lesson_hash"]
    reordered = dict(reversed(list(draft.items())))
    h2 = client.post("/api/drafts/validate", json={"draft": reordered}).json()["lesson_hash"]
    assert h1 == h2


def export_json(client, draft, review=None):
    r = client.post("/api/export/json", json={"draft": draft, "review": review})
    assert r.status_code == 200
    return r.json()


def test_export_import_roundtrip_drops_review(client, draft):
    res = ack(client, draft)
    env = export_json(client, draft, res["review"])
    assert env["status_at_export"] == "acknowledged_by_user"
    r = client.post("/api/drafts/import", content=json.dumps(env, ensure_ascii=False).encode("utf-8"))
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "draft"
    assert "local_review" in body["discarded_claims"]
    assert body["lesson_hash"] == res["lesson_hash"]
    assert body["draft"]["cards"] == draft["cards"]


def test_import_cannot_claim_team_approval(client, draft):
    env = export_json(client, draft)
    env["status"] = "approved"
    env["team_approved"] = True
    env["local_review"] = {"status": "team_published", "reviewer_label": "Official Board"}
    env["draft"]["approved"] = True
    r = client.post("/api/drafts/import", content=json.dumps(env).encode())
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "draft"
    assert {"status", "team_approved", "local_review", "draft.approved"} <= set(body["discarded_claims"])


@pytest.mark.parametrize(
    "payload,code",
    [
        (b"{not json", 400),
        (b"\xff\xfe\x00", 400),
        (b"[1,2]", 400),
        (json.dumps({"format": "balligh.export/9", "draft": {}}).encode(), 422),
        (json.dumps({"format": "balligh.export/1", "draft": {"schema_version": "balligh.lesson/2"}}).encode(), 422),
        (json.dumps({"format": "balligh.export/1", "draft": {"schema_version": "balligh.lesson/1"}}).encode(), 422),
    ],
)
def test_import_rejects_corrupt_or_unsupported(client, payload, code):
    assert client.post("/api/drafts/import", content=payload).status_code == code


def test_import_size_limit(client):
    big = b'{"format":"balligh.export/1","pad":"' + b"x" * (2 * 1024 * 1024) + b'"}'
    assert client.post("/api/drafts/import", content=big).status_code == 413


MALICIOUS = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'><a href="javascript:alert(3)">x</a>'


def test_html_export_escapes_everything(client, draft):
    draft["title"] = MALICIOUS
    draft["cards"][0]["text"] = MALICIOUS
    draft["cards"][1]["editor_note"] = "javascript:alert(4) data:text/html,<b>x</b>"
    draft["terms"][0]["display_form"] = MALICIOUS
    draft["activity"]["question"] = MALICIOUS
    draft["activity"]["options"][0]["text"] = MALICIOUS
    res = ack(client, draft)
    r = client.post(
        "/api/export/html",
        json={"draft": draft, "review": {**res["review"], "reviewer_label": "<script>alert(5)</script>"}},
    )
    assert r.status_code == 200
    html = r.text
    assert "<script" not in html.lower()
    assert "onerror=" not in html.replace("onerror=alert", "")
    assert not re.search(r"<img", html, re.I)
    assert not re.search(r'href="(?!https://)', html)
    assert "&lt;script&gt;" in html
    assert "default-src 'none'" in html
    assert "Test data." in html


def test_html_export_has_bidi_markup(client, draft):
    html = client.post("/api/export/html", json={"draft": draft}).text
    assert '<html lang="en" dir="ltr">' in html
    assert '<blockquote lang="ar" dir="rtl">' in html
    draft["target_locale"] = "ur"
    html_ur = client.post("/api/export/html", json={"draft": draft}).text
    assert '<html lang="ur" dir="rtl">' in html_ur
    assert "Local reference: texts/g1-local-note-ar.txt (no public link" not in html_ur
    assert "no public URL" in html_ur
    assert "<a " not in html_ur


def test_export_refuses_invalid_draft(client, draft):
    draft["spans"][0]["exact_text"] = "x"
    assert client.post("/api/export/html", json={"draft": draft}).status_code == 422


def test_health_reports_disabled_features(client):
    h = client.get("/api/health").json()
    assert h["generation"]["enabled"] is False
    assert h["provider_audio"]["enabled"] is False
    assert h["product_model"] == "deepseek-v4-pro"


def test_locales_report_no_content_review(client):
    rows = client.get("/api/locales").json()
    assert [r["locale"] for r in rows] == ["ar", "en", "ur", "zh-Hans", "id", "bn", "fr"]
    assert all(r["ui_ready"] and not r["content_reviewed"] for r in rows)
    assert not any(r["audio_tested"] or r["source_translation_available"] for r in rows)
    evidence = json.loads((CONTENT / "evidence" / "generation-tested.json").read_text(encoding="utf-8"))["locales"]
    assert {r["locale"] for r in rows if r["generation_tested"]} == set(evidence)
    assert "ar" not in evidence
    assert {r["locale"] for r in rows if r["dir"] == "rtl"} == {"ar", "ur"}


def test_a_configured_key_alone_never_marks_a_locale_tested(tmp_path):
    content = copy_content(tmp_path / "content")
    (content / "evidence" / "generation-tested.json").write_text('{"locales": {}}', encoding="utf-8")
    app = TestClient(create_app(replace(keyed_settings(), content_dir=content)))
    assert app.get("/api/health").json()["generation"]["configured"] is True
    assert not any(r["generation_tested"] for r in app.get("/api/locales").json())


def _import(client, envelope):
    return client.post("/api/drafts/import", content=json.dumps(envelope, ensure_ascii=False).encode("utf-8"))


def _mutate_unknown_source(d):
    d["source_ids"] = ["src-missing"]
    for s in d["spans"]:
        s["source_id"] = "src-missing"
    for t in d["terms"]:
        t["source_ids"] = ["src-missing"]


PROVENANCE_BREAKS = {
    "quote_mismatch": lambda d: d["spans"][0].__setitem__("exact_text", "x"),
    "range_shifted": lambda d: d["spans"][1].__setitem__("start_offset", d["spans"][1]["start_offset"] + 1),
    "range_outside_source": lambda d: d["spans"][2].__setitem__("end_offset", 100000),
    "unknown_source": _mutate_unknown_source,
    "source_version": lambda d: d["spans"][0].__setitem__("source_version", "other"),
}


@pytest.mark.parametrize("name", PROVENANCE_BREAKS)
def test_import_rejects_invalid_provenance(client, draft, name):
    env = export_json(client, draft)
    PROVENANCE_BREAKS[name](env["draft"])
    r = _import(client, env)
    assert r.status_code == 422, r.text
    body = r.json()
    assert "draft" not in body
    assert body["detail"]["errors"]


def test_valid_import_still_accepted_without_approval(client, draft):
    res = ack(client, draft)
    env = export_json(client, draft, res["review"])
    env["team_approved"] = True
    r = _import(client, env)
    assert r.status_code == 200
    assert r.json()["status"] == "draft" and r.json()["valid"] is True
