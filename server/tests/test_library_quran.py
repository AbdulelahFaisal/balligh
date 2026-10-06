import importlib.util
import json
import re
import shutil
from pathlib import Path

import httpx
import pytest

from balligh.library import quran
from balligh.library.fetch import Fetcher
from balligh.library.snapshot import SnapshotError, bytes_hash, file_bytes

SERVER = Path(__file__).resolve().parents[1]
APP = SERVER.parent
FIXTURES = Path(__file__).parent / "fixtures" / "library" / "quran"
REAL = APP / "content" / "library" / "quran"
SAMPLES = APP / "server" / "tests" / "fixtures" / "quran-source-samples"
REAL_CACHE = APP / "var" / "library-cache" / "quran"
SURA = re.compile(r"https://quranenc\.com/api/v1/translation/sura/([a-z_]+)/(\d+)")

spec = importlib.util.spec_from_file_location("import_quran", SERVER / "tools" / "library" / "import_quran.py")
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


def names_page() -> str:
    cards = "".join(
        f'<a class="surah_link py-3" href="https://quranenc.com/ar/browse/arabic_moyassar/{n}"><span class="surah_number">{n}</span>'
        f'<h2 class="fs20 fw-bolder">{quran.SURAH_NAMES[n - 1]}</h2><span>{quran.AYAH_COUNTS[n - 1]} آية</span></a>'
        for n in range(1, 115)
    )
    return f"<html><body>{cards}</body></html>"


def sura_rows(key: str, n: int) -> list[dict]:
    rows = []
    for aya in range(1, quran.AYAH_COUNTS[n - 1] + 1):
        if key == quran.TAFSIR_KEY:
            text, notes = f"تفسير {n}:{aya}", None
        elif key == "chinese_suliman":
            text, notes = f"他们说 {n}:{aya}", ""
        else:
            text = f" {key} «{n}:{aya}»  [1]\n"
            notes = f"[1] note {n}:{aya}\n [2] second" if aya == 1 else (None if key == "indonesian_affairs" and aya == 2 else "")
        rows.append({"id": str(quran.ayah_id(n, aya)), "sura": str(n), "aya": str(aya), "arabic_text": f"نص {n}:{aya} ۝", "translation": text, "footnotes": notes})
    return rows


def respond(body) -> httpx.Response:
    data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
    return httpx.Response(200, content=data, headers={"content-type": "application/json; charset=utf-8"})


class Publisher:
    def __init__(self, overrides=None):
        self.overrides = overrides or {}
        self.calls = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.calls.append(url)
        if url in self.overrides:
            value = self.overrides[url]
            return value if isinstance(value, httpx.Response) else respond(value)
        if url == quran.LIST_URL:
            return respond((FIXTURES / "translations_list.json").read_bytes())
        if url.startswith(quran.LIST_URL + "/"):
            return respond({"translations": []})
        if url in (quran.CATALOG_URL, quran.CATALOG_AR_URL):
            return httpx.Response(200, content=(FIXTURES / "catalog.html").read_bytes(), headers={"content-type": "text/html"})
        if url == quran.TERMS_URL:
            return httpx.Response(200, content=(FIXTURES / "terms.html").read_bytes(), headers={"content-type": "text/html"})
        if url == quran.NAMES_URL:
            return httpx.Response(200, content=names_page().encode("utf-8"), headers={"content-type": "text/html"})
        match = SURA.fullmatch(url)
        if match:
            return respond({"result": sura_rows(match.group(1), int(match.group(2)))})
        return httpx.Response(404)


def fetcher(cache: Path, publisher=None, offline=False) -> Fetcher:
    transport = httpx.MockTransport(publisher or Publisher())
    return Fetcher(cache, offline=offline, transport=transport, sleep=lambda s: None)


def snapshot_bytes(target: Path) -> dict[str, bytes]:
    return {p.relative_to(target).as_posix(): p.read_bytes() for p in sorted(target.rglob("*")) if p.is_file()}


def run(cache: Path, target: Path, publisher=None, offline=False, tafsir=True) -> dict:
    f = fetcher(cache, publisher, offline)
    try:
        return importer.run(f, target, "juz_amma", tafsir)
    finally:
        f.close()


@pytest.fixture(scope="module")
def published(tmp_path_factory):
    root = tmp_path_factory.mktemp("quran")
    summary = run(root / "cache", root / "quran")
    return root, summary


def copy_of(published, tmp_path) -> Path:
    target = tmp_path / "quran"
    shutil.copytree(published[0] / "quran", target)
    return target


def test_juz_amma_import_counts(published):
    root, summary = published
    assert summary["range"] == {"kind": "juz_amma", "surah_first": 78, "surah_last": 114, "surah_count": 37, "ayah_count": 564}
    assert {k: v["ayahs"] for k, v in summary["editions"].items()} == {k: 564 for k in quran.EDITION_KEYS}
    assert summary["editions"]["english_rwwad"]["footnote_ayahs"] == 37
    assert summary["editions"]["indonesian_affairs"]["null_footnotes"] == 37
    assert summary["editions"]["bengali_rwwad"]["version"] == "9.0.5"
    assert summary["editions"]["bengali_rwwad"]["metadata_source"] == quran.CATALOG_URL
    assert summary["tafsir"]["delivered"] is True and summary["tafsir"]["ayahs"] == 564
    assert summary["quarantine"] == [] and summary["failures"] == []
    assert summary["network_requests"] == summary["requests"] == 37 * 7 + 7
    index = json.loads((root / "quran" / "index.json").read_text(encoding="utf-8"))
    assert [s["number"] for s in index["surahs"]] == list(range(78, 115))
    assert index["tafsir"][0]["original_publisher"] == quran.TAFSIR_PUBLISHER and index["tafsir"][0]["delivery"] == "QuranEnc"
    assert any("Synthetic term two for the Noble Quran." in n for n in index["notices"])
    assert any("different for english_rwwad (catalog V9.9.9, API 9.0.1)" in n for n in index["notices"])
    assert quran.validate_quran_dir(root / "quran")["ayahs"] == 564


def test_text_and_footnotes_preserved_exactly(published):
    surah = json.loads((published[0] / "quran" / "surahs" / "078.json").read_text(encoding="utf-8"))
    first, second = surah["ayahs"][0], surah["ayahs"][1]
    assert first["translations"]["en"] == {"text": " english_rwwad «78:1»  [1]\n", "footnotes": "[1] note 78:1\n [2] second"}
    assert first["arabic"] == "نص 78:1 ۝" and first["id"] == 5673
    assert second["translations"]["id"]["footnotes"] == "" and second["translations"]["en"]["footnotes"] == ""
    assert first["tafsir"] == {"arabic_moyassar": "تفسير 78:1"}


def test_cached_reimport_is_byte_identical(published, tmp_path):
    root, summary = published
    target = copy_of(published, tmp_path)
    before = snapshot_bytes(target)
    again = run(root / "cache", target, offline=True)
    assert snapshot_bytes(target) == before
    assert again["network_requests"] == 0 and again["cache_hits"] == again["requests"] == summary["requests"]
    assert again["editions"] == summary["editions"] and again["snapshot_sha256"] == summary["snapshot_sha256"]
    assert not (tmp_path / "quran.staging").exists()


@pytest.mark.parametrize("failure", [
    httpx.Response(500),
    httpx.Response(403),
    {"result": {"oops": 1}},
    {"result": sura_rows("french_rashid", 100)[:-1]},
])
def test_failed_refresh_keeps_previous_snapshot(published, tmp_path, failure):
    target = copy_of(published, tmp_path)
    before = snapshot_bytes(target)
    publisher = Publisher({quran.SURA_URL.format(key="french_rashid", surah=100): failure})
    with pytest.raises(SnapshotError):
        run(tmp_path / "cache", target, publisher)
    assert snapshot_bytes(target) == before
    assert not (tmp_path / "quran.staging").exists()


def test_offline_without_cache_fails_and_keeps_snapshot(published, tmp_path):
    target = copy_of(published, tmp_path)
    before = snapshot_bytes(target)
    with pytest.raises(Exception):
        run(tmp_path / "empty-cache", target, offline=True)
    assert snapshot_bytes(target) == before


def test_arabic_disagreement_is_quarantined(tmp_path):
    rows = sura_rows("french_rashid", 114)
    rows[2]["arabic_text"] = rows[2]["arabic_text"] + "ـ"
    publisher = Publisher({quran.SURA_URL.format(key="french_rashid", surah=114): {"result": rows}})
    summary = run(tmp_path / "cache", tmp_path / "quran", publisher)
    assert summary["range"]["kind"] == "partial" and summary["range"]["ayah_count"] == 563
    assert len(summary["quarantine"]) == 1
    held = summary["quarantine"][0]
    assert (held["surah"], held["aya"], held["id"]) == (114, 3, 6233)
    assert held["arabic_sha256"]["french_rashid"] != held["arabic_sha256"]["english_rwwad"]
    surah = json.loads((tmp_path / "quran" / "surahs" / "114.json").read_text(encoding="utf-8"))
    assert [a["aya"] for a in surah["ayahs"]] == [1, 2, 4, 5, 6]
    assert all(v["ayahs"] == 563 for v in summary["editions"].values())
    assert quran.validate_quran_dir(tmp_path / "quran")["quarantine"] == 1


def test_incomplete_tafsir_is_omitted(tmp_path):
    publisher = Publisher({quran.SURA_URL.format(key=quran.TAFSIR_KEY, surah=90): httpx.Response(404)})
    summary = run(tmp_path / "cache", tmp_path / "quran", publisher)
    assert summary["tafsir"]["delivered"] is False and "omitted" in summary["tafsir"]
    index = json.loads((tmp_path / "quran" / "index.json").read_text(encoding="utf-8"))
    assert index["tafsir"] == [] and index["range"]["kind"] == "juz_amma"
    surah = json.loads((tmp_path / "quran" / "surahs" / "090.json").read_text(encoding="utf-8"))
    assert all(a["tafsir"] == {} for a in surah["ayahs"])


def good_body(n: int = 114) -> list[dict]:
    return sura_rows("english_rwwad", n)


@pytest.mark.parametrize("body, message", [
    (b"not json", "not UTF-8 JSON"),
    (json.dumps({"result": {}}).encode(), "result list"),
    (json.dumps([1, 2]).encode(), "result list"),
    (json.dumps({"result": ["row"]}).encode(), "not an object"),
    (json.dumps({"result": [{k: v for k, v in good_body()[0].items() if k != "footnotes"}] + good_body()[1:]}).encode(), "missing footnotes"),
    (json.dumps({"result": [{**good_body()[0], "sura": "x"}] + good_body()[1:]}).encode(), "not a number"),
    (json.dumps({"result": [{**good_body()[0], "aya": True}] + good_body()[1:]}).encode(), "not a number"),
    (json.dumps({"result": [{**r, "sura": "113"} for r in good_body()]}).encode(), "has sura 113"),
    (json.dumps({"result": [{**good_body()[0], "translation": "  "}] + good_body()[1:]}).encode(), "empty translation"),
    (json.dumps({"result": [{**good_body()[0], "arabic_text": None}] + good_body()[1:]}).encode(), "no arabic_text"),
    (json.dumps({"result": [{**good_body()[0], "footnotes": 3}] + good_body()[1:]}).encode(), "non-text footnotes"),
    (json.dumps({"result": good_body() + [good_body()[0]]}).encode(), "duplicate aya 1"),
    (json.dumps({"result": good_body()[:-1]}).encode(), "missing aya 6"),
    (json.dumps({"result": good_body()[:-1] + [{**good_body()[-1], "aya": "7", "id": "6237"}]}).encode(), "out of range"),
    (json.dumps({"result": [{**good_body()[0], "id": "1"}] + good_body()[1:]}).encode(), "has id 1"),
])
def test_parse_rejects_malformed_shapes(body, message):
    with pytest.raises(SnapshotError, match=message):
        quran.parse_sura(body, "english_rwwad", 114)


def test_parse_keeps_text_and_counts_null_footnotes():
    rows = sura_rows("indonesian_affairs", 114)
    parsed, nulls = quran.parse_sura(json.dumps({"result": rows[::-1]}).encode(), "indonesian_affairs", 114)
    assert nulls == 1 and [r["aya"] for r in parsed] == [1, 2, 3, 4, 5, 6]
    assert parsed[0]["translation"] == rows[0]["translation"] and parsed[1]["footnotes"] == ""


def test_listing_rejects_bad_shapes():
    with pytest.raises(SnapshotError):
        quran.parse_listing(b'{"translations": {}}')
    with pytest.raises(SnapshotError, match="duplicate"):
        quran.parse_listing(b'{"translations": [{"key": "a"}, {"key": "a"}]}')
    entry = json.loads((FIXTURES / "translations_list.json").read_text(encoding="utf-8"))["translations"][2]
    with pytest.raises(SnapshotError, match="language_iso_code"):
        quran.listing_metadata(entry, "chinese_suliman", "ur")


def test_unsafe_index_path_is_rejected(published, tmp_path):
    target = copy_of(published, tmp_path)
    index = json.loads((target / "index.json").read_text(encoding="utf-8"))
    index["surahs"][0]["file"] = "../x.json"
    (target / "index.json").write_bytes(file_bytes(index))
    with pytest.raises(SnapshotError, match="unsafe path"):
        quran.validate_quran_dir(target)


def test_altered_file_bytes_are_detected(published, tmp_path):
    target = copy_of(published, tmp_path)
    path = target / "surahs" / "100.json"
    data = path.read_bytes()
    path.write_bytes(data.replace("نص 100:1".encode("utf-8"), "نص 100:9".encode("utf-8"), 1))
    with pytest.raises(SnapshotError, match="file hash mismatch"):
        quran.validate_quran_dir(target)
    index = json.loads((target / "index.json").read_text(encoding="utf-8"))
    index["surahs"][100 - 78]["sha256"] = bytes_hash(path.read_bytes())
    (target / "index.json").write_bytes(file_bytes(index))
    with pytest.raises(SnapshotError, match="content hash mismatch"):
        quran.validate_quran_dir(target)


def test_index_count_tampering_is_detected(published, tmp_path):
    target = copy_of(published, tmp_path)
    index = json.loads((target / "index.json").read_text(encoding="utf-8"))
    index["editions"][0]["footnote_ayahs"] += 1
    (target / "index.json").write_bytes(file_bytes(index))
    with pytest.raises(SnapshotError, match="counts do not match"):
        quran.validate_quran_dir(target)
    index["editions"][0]["footnote_ayahs"] -= 1
    index["range"]["kind"] = "full"
    (target / "index.json").write_bytes(file_bytes(index))
    with pytest.raises(SnapshotError):
        quran.validate_quran_dir(target)


def test_embedded_ayah_counts():
    assert len(quran.AYAH_COUNTS) == len(quran.SURAH_NAMES) == 114
    assert quran.TOTAL_AYAHS == 6236
    assert sum(quran.AYAH_COUNTS[77:]) == 564
    assert quran.ayah_id(78, 1) == 5673 and quran.ayah_id(114, 6) == 6236


real = pytest.mark.skipif(not (REAL / "index.json").exists(), reason="no delivered Quran snapshot")


def real_surahs() -> dict[int, dict]:
    index = json.loads((REAL / "index.json").read_text(encoding="utf-8"))
    return {s["number"]: json.loads((REAL / s["file"]).read_text(encoding="utf-8")) for s in index["surahs"]}


@real
def test_real_snapshot_has_exact_expected_ids():
    summary = quran.validate_quran_dir(REAL)
    index = json.loads((REAL / "index.json").read_text(encoding="utf-8"))
    first, last = index["range"]["surah_first"], index["range"]["surah_last"]
    held = {q["id"] for q in index["quarantine"]}
    expected = set(range(quran.OFFSETS[first - 1] + 1, quran.OFFSETS[last] + 1)) - held
    surahs = real_surahs()
    for locale in quran.LOCALES:
        ids = [a["id"] for s in surahs.values() for a in s["ayahs"] if a["translations"][locale]["text"]]
        assert len(ids) == len(set(ids)) and set(ids) == expected
    assert {k: v["ayahs"] for k, v in summary["editions"].items()} == {k: len(expected) for k in quran.EDITION_KEYS}
    if index["range"]["kind"] == "full":
        assert summary["ayahs"] == 6236 and index["quarantine"] == []


@real
def test_real_snapshot_first_last_and_juz_amma():
    surahs = real_surahs()
    first = surahs[min(surahs)]["ayahs"][0]
    assert (min(surahs), first["aya"], first["id"]) in ((1, 1, 1), (78, 1, 5673))
    last = surahs[114]["ayahs"][-1]
    assert (last["aya"], last["id"]) == (6, 6236)
    juz = [a["id"] for n in range(78, 115) for a in surahs[n]["ayahs"]]
    assert len(juz) == 564 and juz == list(range(5673, 6237))


@real
def test_real_multi_footnote_ayah_is_verbatim():
    surahs = real_surahs()
    sample = json.loads((SAMPLES / "sura" / "french_rashid" / "114.json").read_text(encoding="utf-8"))["result"][3]
    stored = surahs[114]["ayahs"][3]["translations"]["fr"]
    assert len(re.findall(r"\[\d+\]", sample["footnotes"])) >= 2
    assert stored == {"text": sample["translation"], "footnotes": sample["footnotes"]}
    if 1 in surahs:
        aya = json.loads((SAMPLES / "aya" / "english_rwwad-001-007.json").read_text(encoding="utf-8"))["result"]
        assert len(re.findall(r"\[\d+\]", aya["footnotes"])) == 3
        assert surahs[1]["ayahs"][6]["translations"]["en"] == {"text": aya["translation"], "footnotes": aya["footnotes"]}
        assert surahs[1]["ayahs"][6]["arabic"] == aya["arabic_text"]
    cached = Fetcher(REAL_CACHE, offline=True).cached(quran.SURA_URL.format(key="french_rashid", surah=114))
    if cached is not None:
        raw = cached.json()["result"][3]
        assert stored == {"text": raw["translation"], "footnotes": raw["footnotes"]}


@real
def test_real_snapshot_matches_raw_samples_and_arabic_is_consistent():
    surahs = real_surahs()
    index = json.loads((REAL / "index.json").read_text(encoding="utf-8"))
    assert index["quarantine"] == []
    locales = dict(quran.EDITIONS)
    tafsir = {t["key"] for t in index["tafsir"]}
    checked = 0
    for key in quran.EDITION_KEYS + (quran.TAFSIR_KEY,):
        for n in (1, 78, 114):
            path = SAMPLES / "sura" / key / f"{n:03d}.json"
            if n not in surahs or not path.exists():
                continue
            for row, stored in zip(json.loads(path.read_text(encoding="utf-8"))["result"], surahs[n]["ayahs"], strict=True):
                assert int(row["aya"]) == stored["aya"] and int(row["id"]) == stored["id"]
                assert row["arabic_text"] == stored["arabic"]
                if key == quran.TAFSIR_KEY:
                    if key in tafsir:
                        assert stored["tafsir"][key] == row["translation"]
                else:
                    assert stored["translations"][locales[key]] == {"text": row["translation"], "footnotes": row["footnotes"] or ""}
                checked += 1
    assert checked > 0
