import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from balligh import routes_learn
from balligh.api import create_app
from balligh.routes_learn import EXCLUDED, ManifestError, install, load_manifest, validate_manifest
from helpers import CONTENT, offline_settings

MANIFEST = CONTENT / "learn" / "learn.json"


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
def manifest() -> dict:
    return copy.deepcopy(json.loads(MANIFEST.read_text(encoding="utf-8")))


def rejects(data: dict, library, fragment: str) -> None:
    with pytest.raises(ManifestError) as e:
        validate_manifest(data, library)
    assert fragment in str(e.value)


def test_real_manifest_serves_titles_and_reader_links(client):
    res = client.get("/api/learn")
    assert res.status_code == 200
    body = res.json()
    steps = body["first_steps"]
    assert [s["order"] for s in steps] == list(range(1, len(steps) + 1))
    assert all(s["title"] for s in steps)
    hrefs = {s["source_id"]: s["href"] for s in steps}
    assert hrefs["1"] == "/library/quran/1"
    assert hrefs["binbaz-11423"] == "/library/questions/binbaz-11423"
    assert hrefs["hadeethenc-65000"] == "/library/hadith/hadeethenc-65000"
    ids = {s["source_id"] for s in steps}
    assert not ids & EXCLUDED
    assert all(s["languages"] == ["ar"] for s in steps if s["collection"] == "fatwa")
    teacher = {t["source_id"]: t for t in body["teacher_context"]}
    assert teacher["binbaz-2171"]["classification"] == "teacher_context"
    assert teacher["binbaz-1655"]["classification"] == "teacher_context"
    assert teacher["binbaz-2171"]["href"] == "/library/questions/binbaz-2171"
    assert EXCLUDED <= set(teacher)
    assert not ids & set(teacher)


def test_real_file_validates_directly(library):
    data = load_manifest(MANIFEST, library)
    assert data["schema"] == routes_learn.SCHEMA


def test_unknown_fatwa_id_is_rejected(manifest, library):
    manifest["first_steps"][1]["source_id"] = "binbaz-999999999"
    rejects(manifest, library, "not in the library index")


def test_unknown_teacher_id_is_rejected(manifest, library):
    manifest["teacher_context"][0]["source_id"] = "binbaz-999999998"
    rejects(manifest, library, "not in the library index")


@pytest.mark.parametrize("excluded", ["binbaz-2171", "binbaz-1655", "binbaz-1524", "binbaz-11643"])
def test_excluded_ids_never_enter_the_default_sequence(manifest, library, excluded):
    manifest["first_steps"][1]["source_id"] = excluded
    rejects(manifest, library, "excluded")


def test_teacher_context_record_cannot_also_be_a_first_step(manifest, library):
    manifest["first_steps"][1]["source_id"] = "binbaz-1363"
    rejects(manifest, library, "also in the default sequence")


def test_order_must_be_contiguous(manifest, library):
    manifest["first_steps"][2]["order"] = 7
    rejects(manifest, library, "order must be 3")


def test_duplicate_step_is_rejected(manifest, library):
    manifest["first_steps"][2]["source_id"] = manifest["first_steps"][1]["source_id"]
    rejects(manifest, library, "repeated")


def test_fatwa_languages_must_be_arabic_only(manifest, library):
    manifest["first_steps"][1]["languages"] = ["ar", "en"]
    rejects(manifest, library, "Arabic-only")


def test_hadith_languages_must_exist_for_the_record(manifest, library):
    step = next(s for s in manifest["first_steps"] if s["collection"] == "hadith")
    step["source_id"] = "hadeethenc-10101"
    rejects(manifest, library, "no published content in ['fr']")


def test_quran_languages_and_range_are_checked(manifest, library):
    bad = copy.deepcopy(manifest)
    bad["first_steps"][0]["languages"] = ["ar", "de"]
    rejects(bad, library, "unsupported locales")
    manifest["first_steps"][0]["source_id"] = "115"
    rejects(manifest, library, "not in the delivered Quran range")


def test_unknown_topic_caution_and_extra_fields_are_rejected(manifest, library):
    a = copy.deepcopy(manifest)
    a["first_steps"][0]["topic"] = "anything"
    rejects(a, library, "unknown level or topic")
    b = copy.deepcopy(manifest)
    b["first_steps"][0]["caution"] = "made_up"
    rejects(b, library, "unknown caution")
    manifest["first_steps"][0]["text"] = "injected"
    rejects(manifest, library, "unexpected fields")


def test_wrong_schema_or_version_is_rejected(manifest, library):
    manifest["version"] = "2099-01-01.1"
    rejects(manifest, library, "schema or version")


@pytest.mark.parametrize("content", [b"{broken", b"[]", "﻿{".encode("utf-8")])
def test_broken_manifest_fails_only_the_learn_route(app, client, tmp_path: Path, content: bytes):
    path = tmp_path / "learn.json"
    path.write_bytes(content)
    app.state.learn_manifest = path
    try:
        res = client.get("/api/learn")
        assert res.status_code == 503
        assert res.json()["detail"]["code"] == "learn_unavailable"
        assert client.get("/api/library").status_code == 200
        assert client.get("/api/sources").status_code == 200
    finally:
        del app.state.learn_manifest


def test_missing_manifest_is_503(app, client, tmp_path: Path):
    app.state.learn_manifest = tmp_path / "absent.json"
    try:
        assert client.get("/api/learn").status_code == 503
    finally:
        del app.state.learn_manifest


def test_install_is_idempotent_and_precedes_the_spa_fallback(app, client):
    count = sum(1 for r in app.router.routes if routes_learn.is_learn_route(r))
    install(app)
    assert sum(1 for r in app.router.routes if routes_learn.is_learn_route(r)) == count == 1
    marks = [routes_learn.is_learn_route(r) for r in app.router.routes]
    paths = [getattr(r, "path", None) for r in app.router.routes]
    if "/{path:path}" in paths:
        assert marks.index(True) < paths.index("/{path:path}")
    assert client.get("/api/learn").status_code == 200
