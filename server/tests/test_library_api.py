import json
import shutil
import socket
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from balligh.api import create_app
from balligh.library.catalog import CATALOG_FILE, CATALOG_SCHEMA, Library, index_pins
from balligh.library.snapshot import bytes_hash, content_hash, file_bytes
from helpers import CONTENT, offline_settings

TITLE_1 = "مَا مَعْنَى الشَّهَادَتَيْنِ؟"
HOSTILE = '<script>alert("x")</script><img src=x onerror=alert(1)>'


def write(base: Path, rel: str, value) -> str:
    path = base / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    data = file_bytes(value)
    path.write_bytes(data)
    return bytes_hash(data)


def ayah(n: int, sura: int) -> dict:
    return {
        "aya": n,
        "id": n,
        "arabic": f"آية {sura}:{n}",
        "translations": {"en": {"text": f"verse {sura}:{n}[1]", "footnotes": "[1] a note\n[2] second line" if n == 1 else ""}},
        "tafsir": {},
    }


def build_library(root: Path) -> None:
    surahs = []
    for number, count in ((113, 5), (114, 6)):
        ayahs = [ayah(i, number) for i in range(1, count + 1)]
        body = {"schema": "balligh.library.quran.surah/1", "number": number, "name_ar": f"سورة {number}", "ayah_count": count, "ayahs": ayahs, "content_sha256": content_hash(ayahs)}
        sha = write(root / "quran", f"surahs/{number:03d}.json", body)
        surahs.append({"number": number, "name_ar": f"سورة {number}", "ayah_count": count, "file": f"surahs/{number:03d}.json", "sha256": sha})
    write(
        root / "quran",
        "index.json",
        {
            "schema": "balligh.library.quran.index/1",
            "range": {"kind": "partial-test", "surah_first": 113, "surah_last": 114, "surah_count": 2, "ayah_count": 11},
            "arabic": {"label": "Arabic", "source": "test"},
            "editions": [{"key": "english_test", "locale": "en", "direction": "ltr", "title": "English test", "version": "1", "ayah_count": 11}],
            "tafsir": [],
            "surahs": surahs,
            "quarantine": [],
            "notices": ["test"],
        },
    )
    fatwas = [
        {"id": "binbaz-1", "title": TITLE_1, "topic": "belief", "source_categories": [{"id": "208", "label": "الربوبية والألوهية"}], "question": [[{"kind": "text", "text": "س"}]], "answer": [[{"kind": "text", "text": HOSTILE}]], "source": {"url": "https://binbaz.org.sa/fatwas/1"}, "translations": {}},
        {"id": "binbaz-2", "title": "حكم الصلاة", "topic": "worship", "source_categories": [], "question": [[{"kind": "text", "text": "س2"}]], "answer": [[{"kind": "text", "text": "ج2"}]], "source": {"url": "https://binbaz.org.sa/fatwas/2"}, "translations": {}},
    ]
    hadiths = [
        {"id": "hadeethenc-1", "title": "إنما الأعمال بالنيات", "topic": "belief", "attribution": "متفق عليه", "grade": "صحيح", "text": "نص 1", "source_categories": [], "translations": {"en": {"title": "Actions are by intentions", "text": "text 1", "attribution": "Agreed upon"}}},
        {"id": "hadeethenc-2", "title": "الدين النصيحة", "topic": "conduct", "attribution": "رواه مسلم", "grade": "صحيح", "text": "نص 2", "source_categories": [], "translations": {}},
    ]
    for name, records in (("fatwa", fatwas), ("hadith", hadiths)):
        rows = []
        for rec in records:
            rel = f"records/{rec['id']}.json"
            rows.append({"id": rec["id"], "title": rec["title"], "topic": rec["topic"], "file": rel, "sha256": write(root / name, rel, rec)})
        write(root / name, "index.json", {"schema": f"balligh.library.{name}.index/1", "count": len(rows), "records": rows})
    pins = index_pins(root)
    write(root, CATALOG_FILE, {"schema": CATALOG_SCHEMA, "snapshot": {"id": content_hash(pins)}, "collections": {k: {"index_sha256": v} for k, v in pins.items()}})


@pytest.fixture
def content(tmp_path: Path) -> Path:
    target = tmp_path / "content"
    shutil.copytree(CONTENT, target, ignore=shutil.ignore_patterns("library"))
    build_library(target / "library")
    return target


def client_for(content: Path) -> TestClient:
    return TestClient(create_app(offline_settings(content_dir=content)))


def test_summary_counts_and_locales(content):
    body = client_for(content).get("/api/library").json()["collections"]
    assert body["quran"]["available"] and body["quran"]["locales"]["en"] == 11 and body["quran"]["locales"]["ur"] == 0
    assert body["fatwa"]["count"] == 2 and body["fatwa"]["locales"]["en"] == 0
    assert body["hadith"]["locales"] == {"ar": 2, "en": 1, "ur": 0, "zh-Hans": 0, "id": 0, "bn": 0, "fr": 0}


def test_surah_translation_states_and_navigation(content):
    c = client_for(content)
    en = c.get("/api/library/quran/113?locale=en").json()
    assert en["translation_status"] == "available" and en["next"] == 114 and en["prev"] is None
    assert en["ayahs"][0]["footnotes"] == "[1] a note\n[2] second line" and en["ayahs"][0]["translation"] == "verse 113:1[1]"
    ur = c.get("/api/library/quran/114?locale=ur").json()
    assert ur["translation_status"] == "unavailable" and ur["edition"] is None and ur["dir"] == "rtl"
    assert all(a["translation"] is None and a["arabic"] for a in ur["ayahs"])
    assert c.get("/api/library/quran/114?locale=ar").json()["translation_status"] == "original"
    assert c.get("/api/library/quran/1").status_code == 404
    assert c.get("/api/library/quran/114?locale=de").status_code == 422
    assert c.get("/api/library/quran/abc").status_code == 422
    assert c.get("/api/library/quran/114?tafsir=arabic_moyassar").status_code == 422


def test_listing_filters_search_and_bounds(content):
    c = client_for(content)
    assert [i["id"] for i in c.get("/api/library/fatwas?topic=worship").json()["items"]] == ["binbaz-2"]
    found = c.get("/api/library/fatwas", params={"q": "الشهادتين"}).json()
    assert found["total"] == 1 and found["items"][0]["title"] == TITLE_1
    assert c.get("/api/library/fatwas", params={"q": "الربوبية"}).json()["total"] == 1
    assert c.get("/api/library/hadith", params={"q": "intentions", "locale": "en"}).json()["items"][0]["translated_title"] == "Actions are by intentions"
    assert c.get("/api/library/hadith", params={"q": "لا يوجد"}).json() == {"total": 0, "page": 1, "page_size": 20, "topics": ["belief", "conduct"], "items": []}
    page2 = c.get("/api/library/hadith?page=2&page_size=1").json()
    assert page2["total"] == 2 and [i["id"] for i in page2["items"]] == ["hadeethenc-2"]
    assert c.get("/api/library/hadith?page_size=51").status_code == 422
    assert c.get("/api/library/hadith?page=0").status_code == 422
    assert c.get("/api/library/hadith", params={"q": "x" * 81}).status_code == 422
    assert c.get("/api/library/hadith?topic=fiqh").status_code == 422


def test_record_translation_status_and_inert_text(content):
    c = client_for(content)
    en = c.get("/api/library/hadith/hadeethenc-1?locale=en").json()
    assert en["translation_status"] == "available" and en["translation"]["text"] == "text 1" and "translations" not in en["record"]
    missing = c.get("/api/library/hadith/hadeethenc-2?locale=fr").json()
    assert missing["translation_status"] == "unavailable" and missing["translation"] is None and missing["record"]["text"] == "نص 2"
    fatwa = c.get("/api/library/fatwas/binbaz-1?locale=ar")
    assert fatwa.headers["content-type"].startswith("application/json")
    assert fatwa.json()["record"]["answer"][0][0]["text"] == HOSTILE and fatwa.json()["translation_status"] == "original"
    for bad in ("binbaz-3", "..%2Findex", "hadeethenc-1"):
        assert c.get(f"/api/library/fatwas/{bad}").status_code == 404


def test_altered_record_is_refused_without_content(content):
    c = client_for(content)
    path = content / "library" / "hadith" / "records" / "hadeethenc-2.json"
    path.write_bytes(path.read_bytes().replace("نص 2".encode(), "نص مزور".encode()))
    r = c.get("/api/library/hadith/hadeethenc-2")
    assert r.status_code == 503 and "مزور" not in r.text and r.json()["detail"]["code"] == "integrity"


def test_unpinned_index_disables_only_that_collection(content):
    index = content / "library" / "fatwa" / "index.json"
    index.write_bytes(index.read_bytes() + b" ")
    c = client_for(content)
    assert c.get("/api/library/fatwas").status_code == 503
    assert c.get("/api/library/hadith").status_code == 200
    assert len(c.get("/api/sources").json()) == 4


def test_unsafe_index_path_disables_collection(content):
    root = content / "library"
    index = root / "hadith" / "index.json"
    data = index.read_text(encoding="utf-8").replace("records/hadeethenc-1.json", "../fatwa/records/binbaz-1.json")
    index.write_text(data, encoding="utf-8")
    pins = index_pins(root)
    write(root, CATALOG_FILE, {"schema": CATALOG_SCHEMA, "snapshot": {"id": content_hash(pins)}, "collections": {k: {"index_sha256": v} for k, v in pins.items()}})
    c = client_for(content)
    assert c.get("/api/library/hadith").status_code == 503
    assert c.get("/api/library").json()["collections"]["hadith"]["available"] is False


def test_missing_library_keeps_lesson_api(tmp_path):
    target = tmp_path / "content"
    shutil.copytree(CONTENT, target, ignore=shutil.ignore_patterns("library"))
    c = client_for(target)
    assert c.get("/api/library").json()["collections"]["quran"]["available"] is False
    assert c.get("/api/library/quran").status_code == 503
    assert c.get("/api/examples").status_code == 200


def test_reading_needs_no_network(content, monkeypatch):
    real_connect = socket.socket.connect
    attempts = []

    def guarded(sock, address, *args):
        if isinstance(address, tuple) and address[0] not in ("127.0.0.1", "::1"):
            attempts.append(address)
            raise RuntimeError("network access while reading the library")
        return real_connect(sock, address, *args)

    def blocked(*args, **kwargs):
        attempts.append(args)
        raise RuntimeError("network access while reading the library")

    monkeypatch.setattr(socket.socket, "connect", guarded)
    monkeypatch.setattr(socket, "create_connection", blocked)
    monkeypatch.setattr(socket, "getaddrinfo", blocked)
    c = client_for(content)
    assert c.get("/api/library/quran/114?locale=en").status_code == 200
    assert c.get("/api/library/fatwas/binbaz-2").status_code == 200
    assert c.get("/api/library/hadith?q=النصيحة").json()["total"] == 1
    assert attempts == []


ALL = {"quran", "fatwa", "hadith"}
ROUTES = {"quran": "/api/library/quran", "fatwa": "/api/library/fatwas", "hadith": "/api/library/hadith"}


def _pinned(c: dict, name: str, value) -> dict:
    return {**c, "collections": {**c["collections"], name: value}}


MALFORMED = {
    "collections-empty-list": (lambda c: {**c, "collections": []}, ALL),
    "collections-null": (lambda c: {**c, "collections": None}, ALL),
    "collections-list": (lambda c: {**c, "collections": [c["collections"]]}, ALL),
    "collections-string": (lambda c: {**c, "collections": "quran"}, ALL),
    "collections-missing": (lambda c: {k: v for k, v in c.items() if k != "collections"}, ALL),
    "entry-string": (lambda c: _pinned(c, "fatwa", c["collections"]["fatwa"]["index_sha256"]), {"fatwa"}),
    "entry-list": (lambda c: _pinned(c, "hadith", [c["collections"]["hadith"]]), {"hadith"}),
    "entry-null": (lambda c: _pinned(c, "quran", None), {"quran"}),
    "pin-missing": (lambda c: _pinned(c, "fatwa", {}), {"fatwa"}),
    "pin-null": (lambda c: _pinned(c, "fatwa", {"index_sha256": None}), {"fatwa"}),
    "pin-number": (lambda c: _pinned(c, "hadith", {"index_sha256": 5}), {"hadith"}),
    "pin-not-a-hash": (lambda c: _pinned(c, "quran", {"index_sha256": "abc"}), {"quran"}),
    "collection-missing": (lambda c: {**c, "collections": {k: v for k, v in c["collections"].items() if k != "hadith"}}, {"hadith"}),
    "collection-unknown": (lambda c: _pinned(c, "tafsir", c["collections"]["quran"]), ALL),
    "snapshot-list": (lambda c: {**c, "snapshot": []}, ALL),
    "top-level-list": (lambda c: [c], ALL),
    "top-level-null": (lambda c: None, ALL),
    "top-level-string": (lambda c: "balligh.library.catalog/1", ALL),
}


@pytest.mark.parametrize("case", sorted(MALFORMED))
def test_malformed_catalog_disables_only_library(content, case):
    change, broken = MALFORMED[case]
    path = content / "library" / CATALOG_FILE
    catalog = json.loads(path.read_bytes().decode("utf-8"))
    path.write_bytes(file_bytes(change(catalog)))
    library = Library(content / "library")
    assert set(library.errors) == broken
    c = client_for(content)
    draft = json.loads((content / "examples" / "g1-citation-lesson-en.json").read_bytes().decode("utf-8"))
    for url in ("/api/health", "/api/sources", "/api/examples", "/api/examples/g1-citation-lesson-en", "/api/library"):
        assert c.get(url).status_code == 200, url
    assert c.post("/api/drafts/validate", json={"draft": draft}).status_code == 200
    for name, url in ROUTES.items():
        assert c.get(url).status_code == (503 if name in broken else 200), (name, url)
    assert c.get("/api/library/quran/114").status_code == (503 if "quran" in broken else 200)
    assert c.get("/api/library/fatwas/binbaz-1").status_code == (503 if "fatwa" in broken else 200)
