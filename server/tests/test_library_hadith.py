import copy
import importlib.util
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from balligh.library import hadith, snapshot
from balligh.library.fetch import FetchError, Fetcher

SERVER = Path(__file__).resolve().parents[1]
APP = SERVER.parent
FIXTURES = Path(__file__).parent / "fixtures" / "library" / "hadith"
REAL_DIR = APP / "content" / "library" / "hadith"
REAL_CACHE = APP / "var" / "library-cache" / "hadith"

_spec = importlib.util.spec_from_file_location("import_hadeethenc", SERVER / "tools" / "library" / "import_hadeethenc.py")
importer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(importer)

LANGS = ["ar", "en", "ur", "zh", "id", "bn", "fr"]
SAHIH = "صحيح"


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class FakeHadeethEnc:
    def __init__(self, per_category=7):
        self.ar = fixture("detail_ar.json")
        self.tr = fixture("detail_en.json")
        self.list_meta = fixture("list_page.json")["meta"]
        self.requests = []
        self.grades = {}
        self.texts = {}
        self.detail_override = {}
        self.translation_override = {}
        self.fail = set()
        self.langs = {}
        self.cats = [c for _t, _w, cats in importer.PLAN for c in cats]
        self.lists = {}
        for n, cat in enumerate(self.cats):
            base = 10000 + 100 * n
            self.lists[cat] = [str(base + k) for k in range(1, per_category + 1)]
        self.lists[self.cats[1]].append(self.lists[self.cats[0]][0])
        self.lists[self.cats[-1]].append(self.lists[self.cats[2]][1])

    def transport(self):
        return httpx.MockTransport(self.handle)

    def handle(self, request):
        url = str(request.url)
        self.requests.append(url)
        if url in self.fail:
            return httpx.Response(500, text="error")
        if request.url.host == "dorar.net":
            return httpx.Response(403, text="<title>Attention Required! | Cloudflare</title> Sorry, you have been blocked")
        q = {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
        path = request.url.path
        if path == "/api/v1/categories/list/":
            rows = [{"id": c, "title": f"تصنيف {c}", "hadeeths_count": "9", "parent_id": "3"} for c in self.cats]
            rows.append({"id": "3", "title": "العقيدة", "hadeeths_count": "725", "parent_id": None})
            return httpx.Response(200, json=rows)
        if path == "/api/v1/hadeeths/list/":
            ids = self.lists[q["category_id"]]
            data = [{"id": i, "title": f"عنوان {i}", "translations": self.langs.get(i, LANGS)} for i in ids]
            meta = dict(self.list_meta, total_items=len(ids))
            return httpx.Response(200, json={"data": data, "meta": meta})
        if path == "/api/v1/hadeeths/one/":
            rid, lang = q["id"], q["language"]
            if lang == "ar":
                body = self.detail_override.get(rid) or self.arabic(rid)
            else:
                body = self.translation_override.get((rid, lang)) or self.translation(rid, lang)
            return httpx.Response(200, json=body)
        return httpx.Response(404, text="not found")

    def arabic(self, rid):
        body = copy.deepcopy(self.ar)
        body["id"] = rid
        body["title"] = f"عنوان {rid}"
        body["hadeeth"] = self.texts.get(rid, f"نص الحديث {rid} «قال»")
        body["translations"] = self.langs.get(rid, LANGS)
        body["categories"] = ["3", self.cats[0]]
        grade = self.grades.get(rid, SAHIH)
        if grade is None:
            body.pop("grade")
        else:
            body["grade"] = grade
        return body

    def translation(self, rid, lang):
        body = copy.deepcopy(self.tr)
        body["id"] = rid
        body["title"] = f"{lang} title {rid}"
        body["hadeeth"] = f"{lang} text {rid}"
        body["hadeeth_ar"] = self.texts.get(rid, f"نص الحديث {rid} «قال»")
        body["grade_ar"] = SAHIH
        return body


def run(fake, tmp_path, *, offline=False, target=110, target_dir=None):
    fetcher = Fetcher(tmp_path / "cache", offline=offline, transport=fake.transport(), sleep=lambda s: None)
    try:
        return importer.run_import(fetcher, cache_dir=tmp_path / "cache", target_dir=target_dir or tmp_path / "hadith",
                                   target=target, maximum=200)
    finally:
        fetcher.close()


def tree_bytes(path):
    return {p.relative_to(path).as_posix(): p.read_bytes() for p in sorted(Path(path).rglob("*")) if p.is_file()}


def load_index(path):
    return json.loads((path / "index.json").read_text(encoding="utf-8"))


def test_cached_reimport_is_deterministic_without_double_counting(tmp_path):
    fake = FakeHadeethEnc()
    first = run(fake, tmp_path)
    before = tree_bytes(tmp_path / "hadith")
    assert first["count"] == 110 and first["validation"]["count"] == 110
    assert sum(1 for u in fake.requests if "dorar.net" in u) == 1
    index = load_index(tmp_path / "hadith")
    ids = [r["id"] for r in index["records"]]
    assert len(ids) == len(set(ids)) == index["count"]
    decided = [d[0] for d in index["selection"]["decisions"]]
    assert len(decided) == len(set(decided))
    assert first["full_seven_locales"] == 110
    record = json.loads((tmp_path / "hadith" / index["records"][0]["file"]).read_text(encoding="utf-8"))
    assert set(record["translations"]) == {"en", "ur", "zh-Hans", "id", "bn", "fr"}
    assert record["translations"]["zh-Hans"]["source_language_code"] == "zh"
    assert record["dorar"]["status"] == "not_verified" and "HTTP 403" in record["dorar"]["reason"]
    fake.requests.clear()
    second = run(fake, tmp_path, offline=True)
    assert fake.requests == []
    assert second["network_requests"] == 0 and second["cache_hits"] > 700
    assert tree_bytes(tmp_path / "hadith") == before
    assert {k: second[k] for k in ("count", "per_locale", "topics", "grades_seen")} == \
        {k: first[k] for k in ("count", "per_locale", "topics", "grades_seen")}


def test_failed_or_invalid_refresh_leaves_snapshot_untouched(tmp_path, monkeypatch):
    fake = FakeHadeethEnc()
    run(fake, tmp_path)
    before = tree_bytes(tmp_path / "hadith")
    fresh = FakeHadeethEnc()
    fresh.grades["10001"] = "حسن"
    fresh.fail.add("https://hadeethenc.com/api/v1/hadeeths/one/?language=fr&id=10002")
    other = tmp_path / "other"
    other.mkdir()
    with pytest.raises(FetchError):
        run(fresh, other, target_dir=tmp_path / "hadith")
    assert tree_bytes(tmp_path / "hadith") == before
    real_build = hadith.build_files

    def broken(*args, **kwargs):
        files = real_build(*args, **kwargs)
        rel = next(k for k in files if k.startswith("records/"))
        files[rel] = files[rel].replace(SAHIH.encode("utf-8"), "حسن".encode("utf-8"), 1)
        return files

    monkeypatch.setattr(hadith, "build_files", broken)
    with pytest.raises(snapshot.SnapshotError):
        run(fake, tmp_path, offline=True)
    assert tree_bytes(tmp_path / "hadith") == before
    assert not (tmp_path / "hadith.staging").exists()


@pytest.mark.parametrize("payload", [
    [],
    {"data": "x", "meta": {}},
    {"data": [], "meta": {"current_page": "1", "last_page": "x", "total_items": 1, "per_page": "50"}},
    {"data": [{"id": "abc", "title": "t", "translations": ["ar"]}], "meta": {"current_page": "1", "last_page": 1, "total_items": 1, "per_page": "50"}},
    {"data": [{"id": "5", "title": " ", "translations": ["ar"]}], "meta": {"current_page": "1", "last_page": 1, "total_items": 1, "per_page": "50"}},
    {"data": [{"id": "5", "title": "t", "translations": "ar"}], "meta": {"current_page": "1", "last_page": 1, "total_items": 1, "per_page": "50"}},
])
def test_malformed_list_shapes_are_rejected(payload):
    with pytest.raises(hadith.ShapeError):
        hadith.check_list(payload)


def test_list_and_detail_fixtures_have_the_documented_shape():
    rows, meta = hadith.check_list(fixture("list_page.json"))
    assert rows[0]["id"] == "66512" and meta["current_page"] == 1
    detail = hadith.check_detail(fixture("detail_ar.json"), "66512")
    assert hadith.admission(detail) is None
    tr = hadith.check_translation(fixture("detail_en.json"), "66512", detail)
    assert tr["grade"] == "Authentic"
    assert hadith.arabic_match(tr) == "exact"


@pytest.mark.parametrize("mutate", [
    lambda d: d.pop("hadeeth"),
    lambda d: d.update(hadeeth="   "),
    lambda d: d.update(attribution=None),
    lambda d: d.update(hints="نص"),
    lambda d: d.update(categories=[1, 2]),
    lambda d: d.update(id="66513"),
    lambda d: d.update(grade=["صحيح"]),
])
def test_malformed_detail_shapes_are_rejected(mutate):
    detail = fixture("detail_ar.json")
    mutate(detail)
    with pytest.raises(hadith.ShapeError):
        hadith.check_detail(detail, "66512")


def test_malformed_detail_is_excluded_from_the_import(tmp_path):
    fake = FakeHadeethEnc()
    fake.detail_override["10001"] = {"id": "10001", "title": "x"}
    run(fake, tmp_path)
    index = load_index(tmp_path / "hadith")
    assert "hadeethenc-10001" not in {r["id"] for r in index["records"]}
    reason = next(e["reason"] for e in index["exclusions"] if e["source_record_id"] == "10001")
    assert reason.startswith("malformed detail response")


@pytest.mark.parametrize("grade", ["حسن", "ضعيف", None, "صحيح لغيره", "حسن صحيح", " صحيح", "صحيح ", ""])
def test_non_sahih_grades_are_rejected(grade):
    detail = fixture("detail_ar.json")
    if grade is None:
        detail.pop("grade")
    else:
        detail["grade"] = grade
    hadith.check_detail(detail, "66512")
    assert hadith.admission(detail) is not None


def test_import_excludes_every_non_sahih_grade_and_records_the_distribution(tmp_path):
    fake = FakeHadeethEnc()
    rejected = {"10001": "حسن", "10002": "ضعيف", "10003": None, "10004": "صحيح لغيره"}
    fake.grades.update(rejected)
    fake.texts["10003"] = "قال: حديث صحيح"
    result = run(fake, tmp_path)
    index = load_index(tmp_path / "hadith")
    admitted = {r["id"] for r in index["records"]}
    excluded = {e["source_record_id"]: e["reason"] for e in index["exclusions"]}
    for rid in rejected:
        assert f"hadeethenc-{rid}" not in admitted and rid in excluded
    assert excluded["10003"] == "grade field missing"
    assert all(r["grade"] == SAHIH for r in index["records"])
    grades = index["selection"]["grade_distribution"]
    assert grades["حسن"] == 1 and grades["ضعيف"] == 1 and grades["<missing>"] == 1 and grades["صحيح لغيره"] == 1
    assert result["count"] == 110


def test_translation_with_a_different_id_is_rejected(tmp_path):
    with pytest.raises(hadith.ShapeError):
        hadith.check_translation(dict(fixture("detail_en.json"), id="66513"), "66512", fixture("detail_ar.json"))
    with pytest.raises(hadith.ShapeError):
        hadith.check_translation(dict(fixture("detail_en.json"), grade_ar="حسن"), "66512", fixture("detail_ar.json"))
    fake = FakeHadeethEnc()
    fake.translation_override[("10001", "en")] = fake.translation("10009", "en")
    run(fake, tmp_path, target=154)
    record = json.loads((tmp_path / "hadith" / "records" / "hadeethenc-10001.json").read_text(encoding="utf-8"))
    assert "en" not in record["translations"] and "fr" in record["translations"]
    missing = load_index(tmp_path / "hadith")["selection"]["missing_translations"]
    assert any(m["source_record_id"] == "10001" and m["locale"] == "en" and "does not match" in m["reason"] for m in missing)


def test_missing_languages_are_reported_and_never_created(tmp_path):
    fake = FakeHadeethEnc()
    fake.langs["10001"] = ["ar", "en", "ur"]
    result = run(fake, tmp_path, target=154)
    index = load_index(tmp_path / "hadith")
    entry = next(r for r in index["records"] if r["id"] == "hadeethenc-10001")
    assert entry["locales"] == ["ar", "en", "ur"]
    missing = {m["locale"] for m in index["selection"]["missing_translations"] if m["source_record_id"] == "10001"}
    assert missing == {"zh-Hans", "id", "bn", "fr"}
    assert result["count"] == 154 and result["full_seven_locales"] == 153 and result["per_locale"]["fr"] == 153


def published(tmp_path):
    fake = FakeHadeethEnc()
    run(fake, tmp_path)
    return tmp_path / "hadith"


def rewrite(path, rel, record, index):
    data = snapshot.file_bytes(record)
    (path / rel).write_bytes(data)
    for entry in index["records"]:
        if entry["file"] == rel:
            entry["sha256"] = snapshot.bytes_hash(data)
    (path / "index.json").write_bytes(snapshot.file_bytes(index))


def test_altered_content_and_file_hashes_are_detected(tmp_path):
    path = published(tmp_path)
    assert hadith.validate_hadith_dir(path)["count"] == 110
    index = load_index(path)
    rel = index["records"][3]["file"]
    original = (path / rel).read_bytes()
    record = json.loads(original.decode("utf-8"))
    record["text"] = record["text"] + "ز"
    rewrite(path, rel, record, index)
    with pytest.raises(snapshot.SnapshotError, match="content hash"):
        hadith.validate_hadith_dir(path)
    record = json.loads(original.decode("utf-8"))
    record["translations"]["fr"]["text"] = "altered"
    record["content_sha256"] = hadith.record_hash(record)
    index["records"][3]["content_sha256"] = record["content_sha256"]
    rewrite(path, rel, record, index)
    with pytest.raises(snapshot.SnapshotError, match="translation fr content hash"):
        hadith.validate_hadith_dir(path)
    (path / rel).write_bytes(original.replace(b"\n", b"\n ", 1))
    with pytest.raises(snapshot.SnapshotError, match="file hash mismatch"):
        hadith.validate_hadith_dir(path)


def test_translation_mapping_to_another_id_fails_validation(tmp_path):
    path = published(tmp_path)
    index = load_index(path)
    rel = index["records"][0]["file"]
    record = json.loads((path / rel).read_text(encoding="utf-8"))
    tr = record["translations"]["en"]
    tr["mapping"] = "same HadeethEnc record id 99"
    tr["content_sha256"] = hadith.translation_hash(tr)
    record["content_sha256"] = hadith.record_hash(record)
    index["records"][0]["content_sha256"] = record["content_sha256"]
    rewrite(path, rel, record, index)
    with pytest.raises(snapshot.SnapshotError, match="different record"):
        hadith.validate_hadith_dir(path)


def test_duplicate_ids_are_rejected(tmp_path):
    path = published(tmp_path)
    index = load_index(path)
    records = [json.loads((path / e["file"]).read_text(encoding="utf-8")) for e in index["records"]]
    with pytest.raises(snapshot.SnapshotError, match="duplicate"):
        hadith.build_files(records + [records[0]], [], {}, [])
    index["records"].append(dict(index["records"][0]))
    index["count"] += 1
    (path / "index.json").write_bytes(snapshot.file_bytes(index))
    with pytest.raises(snapshot.SnapshotError, match="duplicate"):
        hadith.validate_hadith_dir(path)


@pytest.mark.parametrize("bad", ["../outside.json", "records/../../outside.json", "/etc/passwd", "records\\x.json", "C:/x.json"])
def test_unsafe_paths_are_rejected(tmp_path, bad):
    path = published(tmp_path)
    index = load_index(path)
    index["records"][0]["file"] = bad
    (path / "index.json").write_bytes(snapshot.file_bytes(index))
    with pytest.raises(snapshot.SnapshotError):
        hadith.validate_hadith_dir(path)


def test_unexpected_files_and_counts_are_rejected(tmp_path):
    path = published(tmp_path)
    (path / "records" / "stray.json").write_text("{}", encoding="utf-8")
    with pytest.raises(snapshot.SnapshotError, match="unexpected file"):
        hadith.validate_hadith_dir(path)
    (path / "records" / "stray.json").unlink()
    with pytest.raises(snapshot.SnapshotError, match="below"):
        hadith.validate_hadith_dir(path, minimum=111)
    with pytest.raises(snapshot.SnapshotError, match="outside"):
        hadith.validate_hadith_dir(path, maximum=109)


def cli(monkeypatch, fake, tmp_path, argv):
    def make(cache_dir, offline=False):
        return Fetcher(tmp_path / "cli-cache", offline=offline, transport=fake.transport(), sleep=lambda s: None)
    monkeypatch.setattr(importer, "Fetcher", make)
    monkeypatch.setattr(importer, "CACHE_DIR", tmp_path / "cli-cache")
    return importer.main(argv)


def test_short_listing_exits_nonzero_and_leaves_out_dir_untouched(tmp_path, monkeypatch, capsys):
    out = published(tmp_path)
    before = tree_bytes(out)
    short = FakeHadeethEnc(per_category=2)
    other = tmp_path / "other"
    other.mkdir()
    with pytest.raises(importer.ShortCollection):
        run(short, other, target=110, target_dir=out)
    assert tree_bytes(out) == before
    code = cli(monkeypatch, short, tmp_path, ["--out", str(out), "--target", "110"])
    assert code not in (0, None)
    assert tree_bytes(out) == before
    assert not out.with_name(out.name + ".staging").exists() and not out.with_name(out.name + ".previous").exists()
    assert hadith.validate_hadith_dir(out)["count"] == 110
    assert '"published": null' in capsys.readouterr().out


def test_incomplete_or_below_minimum_snapshots_never_validate(tmp_path):
    path = published(tmp_path)
    index = load_index(path)
    index["incomplete"] = True
    (path / "index.json").write_bytes(snapshot.file_bytes(index))
    with pytest.raises(snapshot.SnapshotError, match="complete"):
        hadith.validate_hadith_dir(path)
    index["incomplete"] = False
    (path / "index.json").write_bytes(snapshot.file_bytes(index))
    with pytest.raises(snapshot.SnapshotError, match="limits"):
        hadith.validate_hadith_dir(path, minimum=1)
    keep = index["records"][:44]
    for entry in index["records"][44:]:
        (path / entry["file"]).unlink()
    index["records"], index["count"] = keep, len(keep)
    (path / "index.json").write_bytes(snapshot.file_bytes(index))
    with pytest.raises(snapshot.SnapshotError, match="below"):
        hadith.validate_hadith_dir(path)


@pytest.mark.parametrize("parts", [("content", "library"), ("content", "library", "hadith"), ("CONTENT", "Library", "hadith", "x"),
                                   ("var", "..", "content", "library", "hadith")])
def test_out_inside_the_live_library_is_refused(tmp_path, monkeypatch, parts):
    def never(*args, **kwargs):
        raise AssertionError("no fetcher may be created")
    monkeypatch.setattr(importer, "Fetcher", never)
    (tmp_path / "CaseProbe").write_bytes(b"")
    if any(p != p.lower() for p in parts) and not (tmp_path / "caseprobe").exists():
        assert not importer.inside_live(APP.joinpath(*parts))
        return
    assert importer.main(["--offline", "--out", str(APP.joinpath(*parts))]) == 2


def test_default_out_is_the_staging_dir():
    assert importer.TARGET_DIR == APP / "var" / "library-staging" / "hadith"
    assert not importer.inside_live(importer.TARGET_DIR)


def test_differing_hadeeth_ar_rejects_the_translation_without_fallback(tmp_path):
    fake = FakeHadeethEnc()
    variant = fake.translation("10001", "en")
    variant["hadeeth_ar"] = "نص رواية أخرى للحديث 10001"
    fake.translation_override[("10001", "en")] = variant
    result = run(fake, tmp_path, target=154)
    record = json.loads((tmp_path / "hadith" / "records" / "hadeethenc-10001.json").read_text(encoding="utf-8"))
    assert "en" not in record["translations"]
    assert all(t["arabic_match"] == "exact" for t in record["translations"].values())
    index = load_index(tmp_path / "hadith")
    missing = [m for m in index["selection"]["missing_translations"] if m["source_record_id"] == "10001"]
    assert missing == [{"source_record_id": "10001", "locale": "en", "reason": "hadeeth_ar differs from the selected Arabic narration"}]
    assert index["selection"]["hadeeth_ar_mismatch_rejected"] == [["10001", "en"]]
    assert result["arabic_match"]["mismatch"] == 1 and result["per_locale"]["en"] == 153
    with pytest.raises(hadith.NarrationMismatch):
        hadith.check_translation(dict(fixture("detail_en.json"), hadeeth_ar=fixture("detail_ar.json")["hadeeth"] + " "), "66512",
                                 fixture("detail_ar.json"))


def test_missing_hadeeth_ar_is_recorded_as_not_provided(tmp_path):
    fake = FakeHadeethEnc()
    body = fake.translation("10001", "fr")
    body.pop("hadeeth_ar")
    fake.translation_override[("10001", "fr")] = body
    result = run(fake, tmp_path)
    record = json.loads((tmp_path / "hadith" / "records" / "hadeethenc-10001.json").read_text(encoding="utf-8"))
    fr = record["translations"]["fr"]
    assert fr["arabic_match"] == "not_provided"
    assert "byte-for-byte" not in fr["mapping"] and "equals" not in fr["mapping"] and "not compared" in fr["mapping"]
    assert record["translations"]["en"]["arabic_match"] == "exact" and "byte-for-byte" in record["translations"]["en"]["mapping"]
    assert result["arabic_match"]["not_provided"] == 1
    fr["arabic_match"] = "exact"
    fr["content_sha256"] = hadith.translation_hash(fr)
    record["content_sha256"] = hadith.record_hash(record)
    index = load_index(tmp_path / "hadith")
    entry = next(e for e in index["records"] if e["id"] == "hadeethenc-10001")
    entry["content_sha256"] = record["content_sha256"]
    rewrite(tmp_path / "hadith", entry["file"], record, index)
    with pytest.raises(snapshot.SnapshotError, match="different record"):
        hadith.validate_hadith_dir(tmp_path / "hadith")


def test_publisher_word_notes_are_preserved_exactly():
    raw_ar = fixture("one-ar-2945.json")
    raw_en = fixture("one-en-2945.json")
    assert len(raw_ar["words_meanings"]) == 2 and "words_meanings" not in raw_en
    assert raw_en["words_meanings_ar"] == raw_ar["words_meanings"]
    detail = hadith.check_detail(raw_ar, "2945")
    record = hadith.build_record(detail, "t", "conduct", {}, {"status": "not_verified", "reason": "r"}, {})
    assert record["words_meanings"] == raw_ar["words_meanings"] and record["words_meanings_language"] == "ar"
    assert [list(n) for n in record["words_meanings"]] == [list(n) for n in raw_ar["words_meanings"]]
    assert record["explanation"] == raw_ar["explanation"] and record["hints"] == raw_ar["hints"]
    tr = hadith.build_translation("en", hadith.check_translation(raw_en, "2945", detail), "t", detail)
    assert tr["words_meanings"] == [] and tr["words_meanings_language"] is None and tr["arabic_match"] == "exact"
    copied = dict(raw_en, words_meanings=raw_ar["words_meanings"])
    assert hadith.build_translation("en", copied, "t", detail)["words_meanings"] == []
    own = [{"word": "forbids", "meaning": "prohibits"}]
    localized = hadith.build_translation("en", dict(raw_en, words_meanings=own), "t", detail)
    assert localized["words_meanings"] == own and localized["words_meanings_language"] == "en"
    with pytest.raises(hadith.ShapeError):
        hadith.check_detail(dict(raw_ar, words_meanings=[{"word": "x"}]), "2945")


def test_imported_word_notes_keep_the_arabic_copy_out_of_translations(tmp_path):
    raw_ar = fixture("one-ar-2945.json")
    fake = FakeHadeethEnc()
    fake.ar["words_meanings"] = raw_ar["words_meanings"]
    fake.tr["words_meanings_ar"] = raw_ar["words_meanings"]
    result = run(fake, tmp_path)
    index = load_index(tmp_path / "hadith")
    record = json.loads((tmp_path / "hadith" / index["records"][0]["file"]).read_text(encoding="utf-8"))
    assert record["schema"] == "balligh.library.hadith/2" and index["schema"] == "balligh.library.hadith.index/2"
    assert record["words_meanings"] == raw_ar["words_meanings"]
    assert all(t["words_meanings"] == [] and t["words_meanings_language"] is None for t in record["translations"].values())
    assert result["word_notes"] == {"records_with_words_meanings": 110, "arabic_word_notes": 220,
                                    "translations_with_localized_words_meanings": 0}
    record["words_meanings"] = []
    assert hadith.record_hash(record) != index["records"][0]["content_sha256"]


def test_markup_looking_text_is_stored_verbatim_and_inert(tmp_path):
    fake = FakeHadeethEnc()
    markup = "<script>alert(1)</script> &amp; <b>قال</b> {{x}} \r\n"
    fake.texts["10001"] = markup
    run(fake, tmp_path)
    record = json.loads((tmp_path / "hadith" / "records" / "hadeethenc-10001.json").read_text(encoding="utf-8"))
    assert record["text"] == markup
    assert isinstance(record["text"], str)
    assert hadith.validate_hadith_dir(tmp_path / "hadith")["count"] == 110


real_snapshot = pytest.mark.skipif(not (REAL_DIR / "index.json").exists(), reason="no published hadith snapshot")


@real_snapshot
def test_real_snapshot_validates_and_is_in_range():
    summary = hadith.validate_hadith_dir(REAL_DIR)
    assert 100 <= summary["count"] <= 200
    assert summary["incomplete"] is False
    assert summary["full_locale_records"] >= 100


@real_snapshot
@pytest.mark.skipif(not REAL_CACHE.exists(), reason="no hadith importer cache")
def test_real_records_match_the_cached_raw_responses():
    index = load_index(REAL_DIR)
    entries = index["records"]
    fetcher = Fetcher(REAL_CACHE, offline=True)
    try:
        for entry in (entries[0], entries[len(entries) // 2], entries[-1]):
            record = json.loads((REAL_DIR / entry["file"]).read_text(encoding="utf-8"))
            raw = fetcher.cached(record["source"]["api_url"]).json()
            text = record["text"]
            mid = len(text) // 2
            assert text[:30] == raw["hadeeth"][:30]
            assert text[mid:mid + 30] == raw["hadeeth"][mid:mid + 30]
            assert text[-30:] == raw["hadeeth"][-30:]
            assert text == raw["hadeeth"] and record["grade"] == raw["grade"] == SAHIH
            assert record["attribution"] == raw["attribution"] and record["explanation"] == raw["explanation"]
            assert record["hints"] == raw["hints"]
            for locale, tr in record["translations"].items():
                raw_tr = fetcher.cached(tr["api_url"]).json()
                assert raw_tr["id"] == record["source_record_id"]
                assert tr["text"] == raw_tr["hadeeth"] and tr["title"] == raw_tr["title"]
                assert tr["explanation"] == raw_tr["explanation"] and tr["hints"] == raw_tr["hints"]
    finally:
        fetcher.close()
