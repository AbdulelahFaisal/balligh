import copy
import hashlib
import json
from pathlib import Path

from fastapi.testclient import TestClient

from balligh.api import create_app
from balligh.hashing import canonical_json, lesson_hash, sha256_text
from balligh.schemas import LessonDraft
from balligh.sources import load_registry
from helpers import CONTENT, LOCAL_NOTE, RecordingSleep, ScriptedDeepSeek, keyed_settings, lesson_reply, offline_settings

TEXT = load_registry(CONTENT).texts[LOCAL_NOTE]
RID = "11111111-2222-4333-8444-555555555555"


def client(*steps, settings=None):
    scripted = ScriptedDeepSeek(*steps)
    app = create_app(settings or keyed_settings(), transport=scripted.transport(), sleep=RecordingSleep())
    return TestClient(app), scripted


def derive(c, text=TEXT, title="Citation note", ref="My class notes, week 2"):
    r = c.post("/api/teacher-sources/derive", json={"title": title, "text": text, "declared_reference": ref})
    assert r.status_code == 200, r.text
    return r.json()["snapshot"]


def generate(c, snap, rid=RID, locale="en"):
    body = {
        "request_id": rid,
        "source_id": snap["id"],
        "source_version": snap["version"],
        "source_sha256": snap["content_sha256"],
        "target_locale": locale,
        "level": "foundational",
        "teacher_source": snap,
    }
    return c.post("/api/drafts/generate", json=body)


def generated(title="Citation note", ref="My class notes, week 2"):
    c, scripted = client(lesson_reply())
    snap = derive(c, title=title, ref=ref)
    r = generate(c, snap)
    assert r.status_code == 200, r.text
    return c, snap, r.json()


def export_envelope(c, draft, review=None):
    r = c.post("/api/export/json", json={"draft": draft, "review": review})
    assert r.status_code == 200
    return r.json()


def import_on_fresh_server(envelope):
    fresh = TestClient(create_app(offline_settings()))
    return fresh.post("/api/drafts/import", content=json.dumps(envelope, ensure_ascii=False).encode("utf-8"))


def test_server_derives_identity_from_the_exact_text_and_keeps_nothing():
    c, _ = client()
    before = c.get("/api/sources").json()
    r = c.post("/api/teacher-sources/derive", json={"title": "  Note  ", "text": TEXT, "declared_reference": " ref "})
    assert r.status_code == 200
    body = r.json()
    snap = body["snapshot"]
    sha = hashlib.sha256(TEXT.encode("utf-8")).hexdigest()
    assert snap == {
        "id": f"teacher-{sha[:16]}",
        "version": "teacher-1",
        "content_sha256": sha,
        "title": "Note",
        "text": TEXT,
        "language": "ar",
        "declared_reference": "ref",
    }
    assert body["chars"] == len(TEXT) and body["words"] > 0 and body["sentences"] >= 1
    assert c.get("/api/sources").json() == before
    assert c.get(f"/api/sources/{snap['id']}").status_code == 404
    limits = c.get("/api/teacher-sources/limits").json()
    assert limits == {"max_words": 300, "max_chars": 4000, "max_sentences": 30, "max_title_chars": 120, "max_reference_chars": 300}


def test_derive_refuses_empty_non_arabic_and_oversized_text():
    c, _ = client()
    cases = {
        "   ": "empty_text",
        "This is an English paragraph only.": "not_arabic",
        "كلمة " * 301: "too_many_words",
        "ا" * 4001: "too_many_chars",
    }
    for text, code in cases.items():
        r = c.post("/api/teacher-sources/derive", json={"text": text})
        assert r.status_code == 422, text[:20]
        assert r.json()["detail"]["code"] == code


def test_teacher_lesson_generates_validates_acknowledges_and_round_trips_after_restart():
    c, snap, res = generated(title="<script>alert(1)</script> note", ref='Teacher "notes" <b>')
    draft = res["draft"]
    assert res["valid"] and res["errors"] == []
    assert draft["teacher_source"] == snap and draft["source_ids"] == [snap["id"]]
    assert {s["source_id"] for s in draft["spans"]} == {snap["id"]}
    assert all(TEXT[s["start_offset"]:s["end_offset"]] == s["exact_text"] for s in draft["spans"])
    assert snap["id"] not in {s["id"] for s in c.get("/api/sources").json()}

    ack = c.post("/api/reviews/acknowledge", json={
        "draft": draft, "reviewer_label": "Teacher", "confirmed_compared_with_source": True,
    })
    assert ack.status_code == 200, ack.text
    review = ack.json()["review"]
    assert ack.json()["status"] == "acknowledged_by_user"

    html = c.post("/api/export/html", json={"draft": draft, "review": review})
    assert html.status_code == 200
    assert "<script>alert(1)</script>" not in html.text and "&lt;script&gt;" in html.text
    assert "Teacher-supplied text; not verified by Balligh." in html.text
    assert "Reference given by the teacher (not verified)" in html.text and "<b>" not in html.text.split("Reference given")[1][:200]

    envelope = export_envelope(c, draft, review)
    assert envelope["draft"]["teacher_source"]["text"] == TEXT
    imported = import_on_fresh_server(envelope)
    assert imported.status_code == 200, imported.text
    body = imported.json()
    assert body["valid"] and body["draft"]["teacher_source"] == snap
    assert body["status"] != "acknowledged_by_user"
    assert body["lesson_hash"] == res["lesson_hash"]


def test_tampered_or_forged_teacher_sources_are_refused_on_import():
    c, snap, res = generated()
    envelope = export_envelope(c, res["draft"])

    def refused(mutate):
        env = copy.deepcopy(envelope)
        mutate(env["draft"])
        r = import_on_fresh_server(env)
        assert r.status_code == 422, r.text
        return r

    refused(lambda d: d["teacher_source"].update(text=d["teacher_source"]["text"].replace("الإحالة", "الاحالة", 1)))
    refused(lambda d: d["teacher_source"].update(id="lib-fatwa-18975"))
    refused(lambda d: d.pop("teacher_source"))
    refused(lambda d: d["generation"].update(source_sha256="0" * 64))
    refused(lambda d: d["spans"][0].update(end_offset=d["spans"][0]["end_offset"] - 1))
    refused(lambda d: d.update(source_ids=[LOCAL_NOTE]))


def test_meaningful_edits_invalidate_acknowledgment_and_font_scale_does_not():
    c, snap, res = generated()
    draft = res["draft"]
    review = c.post("/api/reviews/acknowledge", json={
        "draft": draft, "reviewer_label": "Teacher", "confirmed_compared_with_source": True,
    }).json()["review"]
    for change in ({"title": "Another title"}, {"declared_reference": "Another reference"}):
        edited = copy.deepcopy(draft)
        edited["teacher_source"].update(change)
        status = c.post("/api/drafts/validate", json={"draft": edited, "review": review}).json()
        assert status["valid"] and status["status"] != "acknowledged_by_user"
    scaled = copy.deepcopy(draft)
    scaled["presentation"]["font_scale"] = 1.25
    assert c.post("/api/drafts/validate", json={"draft": scaled, "review": review}).json()["status"] == "acknowledged_by_user"


def test_two_teacher_texts_stay_isolated_and_the_global_registry_is_unchanged():
    c, _ = client(lesson_reply())
    before = c.get("/api/sources").json()
    first = derive(c)
    other_text = TEXT.replace("الإحالة", "النقل", 1)
    second = derive(c, text=other_text, title="Other")
    assert first["id"] != second["id"]
    res = generate(c, first).json()
    assert res["valid"]
    swapped = copy.deepcopy(res["draft"])
    swapped["teacher_source"] = second
    check = c.post("/api/drafts/validate", json={"draft": swapped}).json()
    assert not check["valid"]
    assert c.get("/api/sources").json() == before


def test_generation_refuses_a_snapshot_that_does_not_match_the_request():
    c, scripted = client()
    snap = derive(c)
    bad = dict(snap, content_sha256="0" * 64)
    r = generate(c, bad)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_teacher_source"
    assert scripted.requests == []


def test_teacher_generation_keeps_no_reply_file_and_no_source_text_on_disk(tmp_path: Path):
    c, _ = client(lesson_reply(), settings=keyed_settings(tmp_path))
    snap = derive(c)
    assert generate(c, snap).status_code == 200
    ledger = (tmp_path / "generation-ledger.jsonl").read_text(encoding="utf-8")
    assert snap["id"] in ledger and TEXT not in ledger and TEXT[:30] not in ledger
    assert not (tmp_path / "responses").exists() or not any((tmp_path / "responses").iterdir())


def _legacy_payload(draft: LessonDraft) -> dict:
    return {
        "schema_version": draft.schema_version,
        "title": draft.title,
        "source_ids": sorted(draft.source_ids),
        "spans": sorted(
            (
                {
                    "id": s.id, "source_id": s.source_id, "source_version": s.source_version,
                    "source_sha256": s.source_sha256, "start_offset": s.start_offset, "end_offset": s.end_offset,
                    "segment_ids": s.segment_ids, "exact_text": s.exact_text,
                }
                for s in draft.spans
            ),
            key=lambda s: s["id"],
        ),
        "target_locale": draft.target_locale,
        "level": draft.level,
        "glossary_version": draft.glossary_version,
        "cards": [c.model_dump() for c in draft.cards],
        "terms": [t.model_dump() for t in draft.terms],
        "activity": draft.activity.model_dump(),
    }


def test_legacy_drafts_keep_their_exact_hash_and_serialization():
    examples = sorted((CONTENT / "examples").glob("*.json"))
    assert examples
    for path in examples:
        raw = json.loads(path.read_text(encoding="utf-8"))
        data = raw.get("draft", raw)
        draft = LessonDraft.model_validate(data)
        assert lesson_hash(draft) == "sha256:" + sha256_text(canonical_json(_legacy_payload(draft)))
        assert "teacher_source" not in draft.model_dump(mode="json")
        assert "teacher_source" not in json.loads(draft.model_dump_json())


def test_derive_reports_known_quran_ayahs_and_markers_without_claiming_completeness():
    c, _ = client()
    text = "قال الله تعالى: ﴿قُلْ هُوَ اللَّهُ أَحَدٌ﴾ وهذا أصل في التوحيد. وقال: الحمد لله رب العالمين."
    q = c.post("/api/teacher-sources/derive", json={"text": text}).json()["quran"]
    assert q["checked"] is True
    assert {"surah": 112, "ayah": 1} in q["matches"] and {"surah": 1, "ayah": 2} in q["matches"]
    assert q["markers"] >= 2
    plain = c.post("/api/teacher-sources/derive", json={"text": TEXT}).json()["quran"]
    assert plain["matches"] == [] and plain["markers"] == 0


def test_a_correctly_hashed_non_arabic_snapshot_is_refused_by_generation_and_import():
    c, scripted = client()
    text = "This is English text written to look like a teacher snapshot."
    sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
    snap = {"id": f"teacher-{sha[:16]}", "version": "teacher-1", "content_sha256": sha, "title": "", "text": text,
            "language": "ar", "declared_reference": ""}
    r = generate(c, snap)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_teacher_source"
    assert scripted.requests == []
    c2, _, res = generated()
    env = export_envelope(c2, res["draft"])
    env["draft"]["teacher_source"] = snap
    assert import_on_fresh_server(env).status_code == 422


def test_a_teacher_text_quoting_a_known_ayah_is_refused_before_any_provider_request():
    c, scripted = client()
    text = TEXT + " قال الله تعالى: ﴿قُلْ هُوَ اللَّهُ أَحَدٌ﴾."
    snap = derive(c, text=text)
    r = generate(c, snap)
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "quran_quotation" and "112:1" in r.json()["detail"]["message"]
    assert scripted.requests == []


def test_quran_markers_alone_refuse_before_any_provider_request():
    c, scripted = client()
    snap = derive(c, text=TEXT + " قال تعالى: ﴿ادْعُ إِلَى سَبِيلِ رَبِّكَ﴾.")
    r = generate(c, snap)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "quran_quotation"
    assert scripted.requests == []


def test_arabic_rule_counts_letters_not_punctuation_or_digits():
    c, _ = client()
    r = c.post("/api/teacher-sources/derive", json={"text": "١٢٣ ، ؟ ٤٥٦ ؛ abc def"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "not_arabic"
