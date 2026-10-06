import json
import shutil
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from balligh.api import create_app
from balligh.hashing import sha256_text
from balligh.library.adapter import (
    ADAPTER_VERSION,
    Ineligible,
    adapt,
    build_unit,
    load_adapters,
    manifest_path,
)
from balligh.library.catalog import Library
from balligh.library.snapshot import bytes_hash, file_bytes
from balligh.sources import load_registry, validate_draft
from balligh.schemas import LessonDraft
from helpers import CONTENT, RecordingSleep, ScriptedDeepSeek, keyed_settings, lesson_reply

FIXTURES = {"src-g1-local-note-ar", "src-g2-negation-ar", "src-g2-condition-ar", "src-g2-exception-ar"}
REAL = {"lib-fatwa-18975", "lib-fatwa-3982", "lib-fatwa-2774", "lib-hadith-10101", "lib-hadith-5351", "lib-hadith-65000"}
FATWA = "lib-fatwa-18975"


def mini_content(tmp: Path) -> Path:
    root = tmp / "content"
    for rel in ("sources", "glossary", "library/fatwa", "library/hadith", "library/adapters"):
        shutil.copytree(CONTENT / rel, root / rel)
    shutil.copy2(CONTENT / "library" / "library.json", root / "library" / "library.json")
    return root


def edit_manifest(content: Path, fn) -> None:
    path = manifest_path(content / "library")
    data = json.loads(path.read_text(encoding="utf-8"))
    fn(data)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def unit(data: dict, uid: str) -> dict:
    return next(u for u in data["units"] if u["id"] == uid)


def body_for(registry, source_id: str, request_id: str = "11111111-2222-4333-8444-555555555555") -> dict:
    rec = registry.sources[source_id]
    return {
        "request_id": request_id,
        "source_id": source_id,
        "source_version": rec.source_version,
        "source_sha256": rec.content_sha256,
        "target_locale": "en",
        "level": "foundational",
    }


def client(content: Path, scripted: ScriptedDeepSeek) -> TestClient:
    settings = replace(keyed_settings(), content_dir=content)
    return TestClient(create_app(settings, transport=scripted.transport(), sleep=RecordingSleep()))


def generated(content: Path, source_id: str = FATWA) -> dict:
    scripted = ScriptedDeepSeek(lesson_reply())
    r = client(content, scripted).post("/api/drafts/generate", json=body_for(load_registry(content), source_id))
    assert r.status_code == 200, r.text
    return r.json()["draft"]


def export_envelope(content: Path, draft: dict) -> bytes:
    app = client(content, ScriptedDeepSeek())
    exported = app.post("/api/export/json", json={"draft": draft, "review": None}).json()
    return json.dumps(exported, ensure_ascii=False).encode("utf-8")


def test_real_units_merge_with_fixtures_into_one_registry():
    registry = load_registry(CONTENT)
    assert registry.adapter_errors == {}
    assert FIXTURES | REAL == set(registry.sources)
    for sid in FIXTURES:
        assert registry.sources[sid].is_test_data and registry.sources[sid].kind == "local_text"
    lib = Library(CONTENT / "library")
    for sid in REAL:
        rec = registry.sources[sid]
        assert rec.kind in ("fatwa", "hadith") and rec.kind == rec.library_collection
        assert rec.is_test_data is False and rec.publisher and rec.canonical_url.startswith("https://")
        assert rec.source_version == f"{ADAPTER_VERSION}:{rec.library_content_sha256.removeprefix('sha256:')}"
        text = registry.texts[sid]
        assert sha256_text(text) == rec.content_sha256 and 0 < len(text.split()) <= 300
        stored = lib.record(rec.kind, rec.library_record_id, "ar")["record"]
        assert stored["source"]["url"] == rec.canonical_url
        if rec.kind == "hadith":
            assert text == stored["text"]
            assert stored["explanation"] not in text
            assert rec.hadith_grade == stored["grade"] and "dorar.net" in rec.external_check
    text = registry.texts[FATWA]
    assert text.startswith("السؤال:\n\nمن أسئلة") and "\n\nالجواب:\n\n" in text


def test_sources_api_exposes_library_mapping():
    app = TestClient(create_app(replace(keyed_settings(), content_dir=CONTENT)))
    rows = {r["id"]: r for r in app.get("/api/sources").json()}
    assert rows[FATWA]["library_record_id"] == "binbaz-18975"
    assert rows[FATWA]["library_collection"] == "fatwa"
    assert rows["src-g1-local-note-ar"]["library_record_id"] is None
    detail = app.get(f"/api/sources/{FATWA}").json()
    assert detail["text"] == load_registry(CONTENT).texts[FATWA]


@pytest.mark.parametrize(
    "tamper",
    [
        lambda c: (c / "library/fatwa/records/binbaz-18975.json").write_bytes(
            (c / "library/fatwa/records/binbaz-18975.json").read_bytes().replace("الشهادة".encode(), "الشهاده".encode(), 1)
        ),
        lambda c: edit_manifest(c, lambda d: unit(d, FATWA).update(text_sha256="0" * 64)),
        lambda c: edit_manifest(c, lambda d: unit(d, FATWA).update(file_sha256="sha256:" + "0" * 64)),
        lambda c: edit_manifest(c, lambda d: unit(d, FATWA).update(record_content_sha256="sha256:" + "1" * 64)),
        lambda c: edit_manifest(c, lambda d: unit(d, FATWA).update(canonical_url="https://binbaz.org.sa/fatwas/1/x")),
        lambda c: edit_manifest(c, lambda d: unit(d, FATWA).update(included_fields=["answer"])),
        lambda c: edit_manifest(c, lambda d: unit(d, FATWA).update(adapter_version="g4b-adapter-0")),
        lambda c: edit_manifest(c, lambda d: unit(d, FATWA).update(id="src-g1-local-note-ar")),
    ],
)
def test_tampered_unit_is_excluded_and_everything_else_works(tmp_path, tamper):
    content = mini_content(tmp_path)
    tamper(content)
    registry = load_registry(content)
    assert FATWA not in registry.sources
    assert registry.adapter_errors
    assert FIXTURES <= set(registry.sources)
    assert registry.sources["src-g1-local-note-ar"].kind == "local_text"
    assert REAL - {FATWA} <= set(registry.sources)


@pytest.mark.parametrize("breakage", ["bad_json", "missing_manifest", "missing_library", "wrong_schema"])
def test_broken_optional_library_leaves_fixtures_usable(tmp_path, breakage):
    content = mini_content(tmp_path)
    path = manifest_path(content / "library")
    if breakage == "bad_json":
        path.write_text("{not json", encoding="utf-8")
    elif breakage == "missing_manifest":
        path.unlink()
    elif breakage == "missing_library":
        (content / "library" / "library.json").unlink()
    else:
        edit_manifest(content, lambda d: d.update(schema="other/1"))
    registry = load_registry(content)
    assert set(registry.sources) == FIXTURES
    assert registry.adapter_errors
    draft = generated(content, "src-g1-local-note-ar")
    assert draft["source_ids"] == ["src-g1-local-note-ar"]


def fatwa_rec(**overrides) -> dict:
    rec = {
        "language": "ar",
        "question": [[{"kind": "strong", "text": "السؤال:"}], [{"kind": "text", "text": "ما الحكم؟"}]],
        "answer": [[{"kind": "text", "text": "الجواب نعم"}, {"kind": "noteref", "text": "[1]"}]],
        "notes": [{"id": 1, "runs": [{"kind": "text", "text": "حاشية"}]}],
    }
    rec.update(overrides)
    return rec


def test_fatwa_representation_keeps_paragraphs_notes_and_mapped_honorifics():
    text = adapt("fatwa", fatwa_rec(answer=[[{"kind": "text", "text": "الله  أعلم"}, {"kind": "noteref", "text": "[1]"}]]))
    assert text == "السؤال:\n\nما الحكم؟\n\nالله سبحانه وتعالى أعلم[1]\n\nالحواشي:\n[1] حاشية"


@pytest.mark.parametrize(
    "collection, rec, reason",
    [
        ("fatwa", fatwa_rec(answer=[[{"kind": "text", "text": "كلمة " * 301}]]), "words"),
        ("fatwa", fatwa_rec(answer=[[{"kind": "text", "text": "رمز "}]]), "F0FF"),
        ("fatwa", fatwa_rec(answer=[[{"kind": "image", "text": "x"}]]), "run kind"),
        ("fatwa", fatwa_rec(question=[]), "question"),
        ("fatwa", fatwa_rec(language="en"), "Arabic"),
        ("fatwa", fatwa_rec(answer=[[{"kind": "text", "text": "جملة. " * 40}]]), "segments"),
        ("hadith", {"language": "ar", "text": "  "}, "no text"),
        ("quran", {"language": "ar", "text": "بسم الله"}, "never eligible"),
        ("quran_translation", {"language": "en", "text": "In the name"}, "never eligible"),
        ("book", {"language": "en", "text": "A book"}, "never eligible"),
    ],
)
def test_ineligible_units(collection, rec, reason):
    with pytest.raises(Ineligible, match=reason):
        adapt(collection, rec)


def test_quran_unit_in_manifest_is_rejected(tmp_path):
    content = mini_content(tmp_path)
    edit_manifest(content, lambda d: d["units"].append({**unit(d, FATWA), "id": "lib-quran-1", "collection": "quran"}))
    registry = load_registry(content)
    assert "lib-quran-1" not in registry.sources
    assert "never eligible" in registry.adapter_errors["lib-quran-1"]


def test_client_supplied_text_and_url_are_ignored(tmp_path):
    content = mini_content(tmp_path)
    registry = load_registry(content)
    scripted = ScriptedDeepSeek()
    app = client(content, scripted)
    for extra in ({"source_text": "نص مزور"}, {"canonical_url": "https://evil.example/x"}, {"text": "x"}):
        r = app.post("/api/drafts/generate", json={**body_for(registry, FATWA), **extra})
        assert r.status_code == 422
    r = app.post("/api/drafts/generate", json={**body_for(registry, FATWA), "source_sha256": sha256_text("نص مزور")})
    assert r.status_code == 409
    assert scripted.requests == []
    scripted = ScriptedDeepSeek(lesson_reply())
    r = client(content, scripted).post("/api/drafts/generate", json=body_for(registry, FATWA))
    sent = json.dumps(scripted.bodies[0], ensure_ascii=False)
    assert "نص مزور" not in sent and "evil.example" not in sent
    assert "من أسئلة هذا السائل من الرياض" in sent
    draft = r.json()["draft"]
    assert draft["is_test_data"] is False and draft["generation"]["source_sha256"] == registry.sources[FATWA].content_sha256


def test_restart_and_reimport_resolve_the_same_stable_source(tmp_path):
    content = mini_content(tmp_path)
    first = load_registry(content)
    draft = generated(content)
    raw = export_envelope(content, draft)
    second = load_registry(content)
    assert first.sources[FATWA] == second.sources[FATWA] and first.texts[FATWA] == second.texts[FATWA]
    restarted = client(content, ScriptedDeepSeek())
    imported = restarted.post("/api/drafts/import", content=raw)
    assert imported.status_code == 200, imported.text
    assert imported.json()["status"] == "draft"
    assert imported.json()["draft"]["spans"] == draft["spans"]


@pytest.mark.parametrize("field, value", [("source_id", "lib-fatwa-999999"), ("source_version", "g4b-adapter-1:" + "0" * 64), ("source_sha256", "0" * 64)])
def test_imported_draft_with_wrong_source_identity_is_rejected(tmp_path, field, value):
    content = mini_content(tmp_path)
    draft = generated(content)
    for span in draft["spans"]:
        span[field] = value
    r = client(content, ScriptedDeepSeek()).post("/api/drafts/import", content=export_envelope(content, draft))
    assert r.status_code == 422


def refresh_record(content: Path) -> None:
    lib = content / "library"
    rel = "records/binbaz-18975.json"
    rec = json.loads((lib / "fatwa" / rel).read_text(encoding="utf-8"))
    rec["answer"][-1][-1]["text"] += " وفقكم الله."
    rec["content_sha256"] = "sha256:" + sha256_text(json.dumps(rec["answer"], ensure_ascii=False))
    data = file_bytes(rec)
    (lib / "fatwa" / rel).write_bytes(data)
    index = json.loads((lib / "fatwa" / "index.json").read_text(encoding="utf-8"))
    next(r for r in index["records"] if r["id"] == "binbaz-18975")["sha256"] = bytes_hash(data)
    index_bytes = file_bytes(index)
    (lib / "fatwa" / "index.json").write_bytes(index_bytes)
    catalog = json.loads((lib / "library.json").read_text(encoding="utf-8"))
    catalog["collections"]["fatwa"]["index_sha256"] = bytes_hash(index_bytes)
    (lib / "library.json").write_bytes(file_bytes(catalog))


def test_refreshed_record_never_silently_validates_an_older_draft(tmp_path):
    content = mini_content(tmp_path)
    old = LessonDraft.model_validate(generated(content))
    refresh_record(content)
    stale = load_registry(content)
    assert FATWA not in stale.sources and FATWA in stale.adapter_errors
    assert validate_draft(old, stale)
    built, _, _ = build_unit(Library(content / "library"), "fatwa", "binbaz-18975")
    edit_manifest(content, lambda d: unit(d, FATWA).update({k: built[k] for k in ("file_sha256", "record_content_sha256", "text_sha256")}))
    fresh = load_registry(content)
    assert FATWA in fresh.sources
    assert fresh.sources[FATWA].source_version != old.spans[0].source_version
    errors = validate_draft(old, fresh)
    assert any("version/hash" in e for e in errors)


def test_manifest_matches_a_fresh_deterministic_build():
    data = json.loads(manifest_path(CONTENT / "library").read_text(encoding="utf-8"))
    lib = Library(CONTENT / "library")
    for u in data["units"]:
        built, _, _ = build_unit(lib, u["collection"], u["record_id"])
        assert {k: u[k] for k in built} == built
    assert {r["record_id"] for r in data["rejected"]} >= {"binbaz-3521", "binbaz-10220", "hadeethenc-4319", "hadeethenc-5866"}
