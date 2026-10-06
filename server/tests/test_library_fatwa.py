import copy
import html
import importlib.util
import json
import re
from pathlib import Path
from urllib.parse import quote

import httpx
import pytest

from balligh.library import fatwa, snapshot
from balligh.library.fetch import Fetcher
from balligh.library.snapshot import SnapshotError

SERVER = Path(__file__).resolve().parents[1]
APP = SERVER.parent
FIXTURES = Path(__file__).parent / "fixtures" / "library" / "fatwa"
REAL = APP / "content" / "library" / "fatwa"
STAGING = APP / "var" / "library-staging" / "fatwa"
CACHE = APP / "var" / "library-cache" / "fatwa"
URL_18975 = "https://binbaz.org.sa/fatwas/18975/" + quote("ما-معنى-الشهادتين")
URL_19825 = "https://binbaz.org.sa/fatwas/19825/" + quote("حكم-قراءة-القران-الكريم-لمن-لا-يجيد-قواعد-اللغة-العربية")
AAYA = "ذَلِكَ بِأَنَّ اللَّهَ هُوَ الْحَقُّ وَأَنَّ مَا يَدْعُونَ مِنْ دُونِهِ هُوَ الْبَاطِلُ"
HADITH_1 = "خيركم من تعلم القرآن وعلمه"
HADITH_2 = "الماهر بالقرآن مع السفرة الكرام البررة، والذي يقرأ القرآن وهو عليه شاق ويتتعتع فيه له أجران"


def load_importer():
    spec = importlib.util.spec_from_file_location("import_binbaz_under_test", SERVER / "tools" / "library" / "import_binbaz.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def page(name):
    return (FIXTURES / name).read_bytes().decode("utf-8")


def raw_aaya():
    doc = page("18975.html")
    start = doc.index('<span class="aaya">') + len('<span class="aaya">')
    return doc[start:doc.index("</span>", start)]


def record_for(name, url, topic="belief"):
    parsed = fatwa.parse_page(page(name))
    return fatwa.build_record(parsed, url, "2026-10-06T03:50:00+00:00", topic), parsed


def text_of(paragraphs):
    return fatwa.plain_text(paragraphs)


def all_runs(record):
    return [run for field in ("question", "answer") for p in record[field] for run in p]


def test_18975_full_question_and_answer():
    record, parsed = record_for("18975.html", URL_18975)
    fatwa.check_against_raw(record, parsed["article_html"])
    assert record["title"] == "ما معنى الشهادتين؟"
    assert record["question"][0] == [{"kind": "strong", "text": "السؤال:"}]
    assert record["question"][1] == [{"kind": "text", "text": "من أسئلة هذا السائل من الرياض يقول: ما معنى (شهادة أن لا إله إلا الله وأن محمدًا رسول الله)؟"}]
    assert record["answer"][0] == [{"kind": "strong", "text": "الجواب:"}]
    answer = text_of(record["answer"])
    assert "معنى الشهادة: أن يشهد بلسانه وبقلبه أنه لا معبود حق إلا الله" in answer
    assert "ومعنى شهادة (أن محمدًا رسول الله) أن تشهد عن علم ويقين" in answer
    aaya = raw_aaya()
    assert snapshot.search_key(aaya) == snapshot.search_key(AAYA)
    quran = [r for r in all_runs(record) if r["kind"] == "quran"]
    assert quran == [{"kind": "quran", "text": aaya}]
    second = record["answer"][1]
    assert second[1] == {"kind": "quran", "text": aaya}
    assert "شهادة أن لا إله إلا الله" in answer and "أن محمد بن عبد الله بن عبد المطلب هو رسول الله حقًا" in answer
    assert second[2]["text"].startswith(" [الحج:62]، هذا معنى شهادة أن لا إله إلا الله")
    assert record["answer"][-1] == [{"kind": "strong", "text": "المقدم:"}, {"kind": "text", "text": " حفظكم الله."}]
    assert record["source_categories"] == [{"id": "208", "label": "الربوبية والألوهية", "url": "https://binbaz.org.sa/categories/objective/208"}]
    assert record["source"]["series"] == "نور على الدرب"
    assert record["translations"] == {}
    assert record["raw_sha256"] == snapshot.bytes_hash(parsed["article_html"].encode("utf-8"))
    assert "mp3" not in json.dumps(record)


def test_19825_hadith_quotations_and_references():
    record, parsed = record_for("19825.html", URL_19825, "worship")
    fatwa.check_against_raw(record, parsed["article_html"])
    assert record["title"] == "حكم قراءة القرآن الكريم لمن لا يجيد قواعد اللغة العربية"
    assert record["question"][1][0]["text"] == "لي قريب يحب قراءة القرآن الكريم، غير أنه لا يجيد قواعد اللغة العربية والتلاوة، فماذا يفعل؟"
    hadith = [r["text"] for r in all_runs(record) if r["kind"] == "hadith"]
    assert hadith == [HADITH_1, HADITH_2]
    answer = text_of(record["answer"])
    assert "[1] أخرجه البخاري في صحيحه" in answer
    assert "أخرجه البخاري في (فضائل القرآن)، برقم: 4639" not in answer
    assert "أخرجه البخاري في (فضائل القرآن)، برقم: 4639" in fatwa.note_text(record["notes"][0])
    assert record["notes"][-1]["runs"] == [{"kind": "text", "text": "نشر في (مجلة الدعوة)، العدد رقم: 1520، في 15/7/1416هـ. (مجموع فتاوى ومقالات الشيخ ابن باز 24/ 357)."}]
    assert record["source"]["edition"] == "مجموع فتاوى ومقالات الشيخ ابن باز 24/ 357"
    assert record["source"]["series"] == "مجموع الفتاوى"


@pytest.mark.parametrize("name,url", [("18975.html", URL_18975), ("19825.html", URL_19825)])
def test_beginning_middle_end_match_raw_fixture(name, url):
    record, parsed = record_for(name, url)
    parts = fatwa.article_fragments(parsed["article_html"])
    raw = fatwa.raw_segments(parts["answer"])
    mine = [" ".join(fatwa.paragraph_text(p).split()) for p in record["answer"]]
    assert len(raw) == len(mine) >= 2
    for i in (0, len(raw) // 2, len(raw) - 1):
        assert mine[i] == raw[i]
    assert [" ".join(fatwa.paragraph_text(p).split()) for p in record["question"]] == fatwa.raw_segments(parts["question"])


def test_hostile_markup_is_inert():
    record, parsed = record_for("hostile.html", "https://binbaz.org.sa/fatwas/99999/hostile")
    fatwa.check_against_raw(record, parsed["article_html"])
    fatwa.validate_record(record)
    blob = json.dumps(record, ensure_ascii=False).replace('<b onclick=\\"x()\\">نص ظاهر</b>', "")
    for leak in ("alert", "script", "javascript", "onclick", "onmouseover", "onerror", "onload", "iframe", "evil.example",
                 "leak-", "color:red", "steal", "style", "<p", "<span", "<img", "<a ", "href", "window"):
        assert leak not in blob, leak
    assert record["title"] == "عنوان الاختبار"
    assert record["question"][1] == [{"kind": "text", "text": "سؤال رابط آمن؟"}]
    runs = record["answer"][1]
    assert runs[0] == {"kind": "text", "text": "قبل بعد نص "}
    assert runs[1] == {"kind": "quran", "text": "آية ۝ تالية"}
    assert runs[2] == {"kind": "text", "text": " [البقرة:1] <b onclick=\"x()\">نص ظاهر</b>\nسطر ثان"}
    assert record["answer"][-1] == [{"kind": "text", "text": "نهاية"}]
    assert all(set(r) == {"kind", "text"} for r in all_runs(record))
    assert record["notes"] == []


def write_dir(tmp_path, records):
    files = fatwa.build_files(records, [], {"start_urls": ["https://binbaz.org.sa/x"], "rationale": "test"}, ["notice"])
    base = tmp_path / "fatwa"
    for rel, data in files.items():
        path = base / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return base


def two_records():
    return [record_for("18975.html", URL_18975)[0], record_for("19825.html", URL_19825, "worship")[0]]


def rewrite_index(base, change):
    index = json.loads((base / "index.json").read_bytes())
    change(index)
    (base / "index.json").write_bytes(snapshot.file_bytes(index))


def rewrite_record(base, rid, change, fix_hash=True, fix_content=False):
    path = base / "records" / f"{rid}.json"
    record = json.loads(path.read_bytes())
    change(record)
    if fix_content:
        record["content_sha256"] = snapshot.content_hash({k: v for k, v in record.items() if k != "content_sha256"})
    data = snapshot.file_bytes(record)
    path.write_bytes(data)
    if fix_hash:
        def update(index):
            for entry in index["records"]:
                if entry["id"] == rid:
                    entry["sha256"] = snapshot.bytes_hash(data)
                    entry["content_sha256"] = record["content_sha256"]
        rewrite_index(base, update)


def test_valid_dir_and_raw_verification(tmp_path):
    base = write_dir(tmp_path, two_records())
    raw = {"binbaz-18975": fatwa.parse_page(page("18975.html"))["article_html"], "binbaz-19825": fatwa.parse_page(page("19825.html"))["article_html"]}
    summary = fatwa.validate_fatwa_dir(base, raw=raw)
    assert summary["count"] == 2 and summary["quran_runs"] == 1 and summary["hadith_runs"] == 2


def test_duplicate_ids_rejected(tmp_path):
    records = two_records()
    with pytest.raises(SnapshotError, match="duplicate"):
        fatwa.build_files([records[0], copy.deepcopy(records[0])], [], {}, [])
    base = write_dir(tmp_path, records)
    rewrite_index(base, lambda index: (index["records"].append(dict(index["records"][0])), index.update(count=3)))
    with pytest.raises(SnapshotError, match="duplicate"):
        fatwa.validate_fatwa_dir(base)


@pytest.mark.parametrize("field,value", [
    ("question", [[{"kind": "strong", "text": "السؤال:"}]]),
    ("answer", [[{"kind": "strong", "text": "الجواب: "}]]),
    ("answer", []),
    ("question", [[{"kind": "text", "text": "   "}]]),
    ("answer", [[{"kind": "text", "text": ""}]]),
    ("title", ""),
])
def test_blank_or_label_only_rejected(tmp_path, field, value):
    base = write_dir(tmp_path, two_records())
    rewrite_record(base, "binbaz-18975", lambda r: r.update({field: value}), fix_content=True)
    with pytest.raises(SnapshotError):
        fatwa.validate_fatwa_dir(base)


def test_truncated_answer_detected_against_raw():
    record, parsed = record_for("19825.html", URL_19825)
    truncated = copy.deepcopy(record)
    truncated["answer"] = truncated["answer"][:-1]
    with pytest.raises(SnapshotError, match="paragraphs"):
        fatwa.check_against_raw(truncated, parsed["article_html"])
    clipped = copy.deepcopy(record)
    clipped["answer"][1][0]["text"] = clipped["answer"][1][0]["text"][:40]
    with pytest.raises(SnapshotError, match="differs"):
        fatwa.check_against_raw(clipped, parsed["article_html"])
    relabelled = copy.deepcopy(record)
    relabelled["answer"][1][1]["kind"] = "text"
    with pytest.raises(SnapshotError, match="hadith"):
        fatwa.check_against_raw(relabelled, parsed["article_html"])
    with pytest.raises(SnapshotError, match="raw_sha256"):
        fatwa.check_against_raw(record, parsed["article_html"].replace("الجواب", "الجواب ", 1))


def test_altered_bytes_and_content_hash_detected(tmp_path):
    base = write_dir(tmp_path, two_records())
    path = base / "records" / "binbaz-19825.json"
    path.write_bytes(path.read_bytes().replace("أجران".encode("utf-8"), "أجر".encode("utf-8"), 1))
    with pytest.raises(SnapshotError, match="file hash mismatch"):
        fatwa.validate_fatwa_dir(base)
    base = write_dir(tmp_path / "second", two_records())
    rewrite_record(base, "binbaz-18975", lambda r: r["answer"][1][0].update(text="نص مختلف"))
    with pytest.raises(SnapshotError, match="content_sha256"):
        fatwa.validate_fatwa_dir(base)


@pytest.mark.parametrize("bad", ["../records/binbaz-18975.json", "/etc/passwd", "records\\binbaz-18975.json", "C:records/x.json", "records/../../x.json", "records/binbaz-18975.json/.."])
def test_unsafe_index_paths_rejected(tmp_path, bad):
    base = write_dir(tmp_path, two_records())
    rewrite_index(base, lambda index: index["records"][0].update(file=bad))
    with pytest.raises(SnapshotError):
        fatwa.validate_fatwa_dir(base)


def test_unindexed_file_and_bad_source_rejected(tmp_path):
    base = write_dir(tmp_path, two_records())
    (base / "records" / "binbaz-1.json").write_bytes(b"{}\n")
    with pytest.raises(SnapshotError, match="unindexed"):
        fatwa.validate_fatwa_dir(base)
    base = write_dir(tmp_path / "second", two_records())
    rewrite_record(base, "binbaz-18975", lambda r: r["source"].update(url="http://binbaz.org.sa/fatwas/18975/x"), fix_content=True)
    with pytest.raises(SnapshotError, match="source url"):
        fatwa.validate_fatwa_dir(base)
    base = write_dir(tmp_path / "third", two_records())
    rewrite_record(base, "binbaz-18975", lambda r: r.update(topic="fiqh"), fix_content=True)
    with pytest.raises(SnapshotError, match="topic"):
        fatwa.validate_fatwa_dir(base)


LISTING = """<html><body>
<article class="box__body__element fatwa"><h1><a href="{a}">A</a></h1><p>...</p></article>
<article class="box__body__element fatwa"><h1><a href="{a}">A again</a></h1></article>
<article class="box__body__element fatwa"><h1><a href="{b}">B</a></h1></article>
</body></html>"""


def mock_site(overrides=None):
    pages = {
        "https://binbaz.org.sa/categories/objective/208/fatwa": LISTING.format(a=URL_18975, b=URL_19825).encode("utf-8"),
        "https://binbaz.org.sa/categories/objective/208/fatwa?page=2": b"<html><body></body></html>",
        URL_18975: (FIXTURES / "18975.html").read_bytes(),
        URL_19825: (FIXTURES / "19825.html").read_bytes(),
    }
    calls = []

    def handler(request):
        url = str(request.url)
        calls.append(url)
        if overrides and url in overrides:
            status, body = overrides[url]
            return httpx.Response(status, content=body, headers={"content-type": "text/html; charset=UTF-8"})
        if url in pages:
            return httpx.Response(200, content=pages[url], headers={"content-type": "text/html; charset=UTF-8"})
        return httpx.Response(404, content=b"missing")

    return httpx.MockTransport(handler), calls


CATS = [{"kind": "objective", "id": "208", "label": "الربوبية والألوهية", "topic": "belief", "why": "test"}]
QUOTAS = {"understanding_islam": 0, "belief": 2, "worship": 0, "conduct": 0}


def run_import(importer, cache, target_dir, **kw):
    return importer.run(cache, target_dir, target=2, quotas=QUOTAS, categories=CATS, seeds=[], start_urls=["https://binbaz.org.sa/categories/objective/208/fatwa"], sleep=lambda s: None, **kw)


def snapshot_bytes(base):
    return {p.relative_to(base).as_posix(): p.read_bytes() for p in sorted(base.rglob("*")) if p.is_file()}


def test_cached_reimport_is_deterministic_without_double_counting(tmp_path):
    importer = load_importer()
    transport, calls = mock_site()
    target_dir = tmp_path / "content" / "fatwa"
    first = run_import(importer, tmp_path / "cache", target_dir, transport=transport)
    assert first["count"] == 2 and first["fetched"] == 3 and first["duplicates_skipped"] == 1
    assert len(calls) == len(set(calls)) == 3
    before = snapshot_bytes(target_dir)
    second = run_import(importer, tmp_path / "cache", target_dir, offline=True)
    assert second["count"] == 2 and second["fetched"] == 0 and second["network_requests"] == 0 and second["cache_hits"] == 3
    assert snapshot_bytes(target_dir) == before
    index = json.loads(before["index.json"])
    assert [e["id"] for e in index["records"]] == ["binbaz-18975", "binbaz-19825"]
    assert index["count"] == 2 and len(before) == 3
    fatwa.validate_fatwa_dir(target_dir)


@pytest.mark.parametrize("override", [(500, b"server error"), (200, b"<html><body><p>maintenance</p></body></html>"), (200, b"<html><article class=\"fatwa\"><h1 class=\"article-title\">x</h1>")])
def test_failed_or_partial_refresh_keeps_snapshot(tmp_path, override):
    importer = load_importer()
    transport, _ = mock_site()
    target_dir = tmp_path / "content" / "fatwa"
    run_import(importer, tmp_path / "cache", target_dir, transport=transport)
    before = snapshot_bytes(target_dir)
    broken, _ = mock_site({URL_19825: override})
    with pytest.raises(importer.ImportFailure):
        run_import(importer, tmp_path / "fresh-cache", target_dir, transport=broken)
    assert snapshot_bytes(target_dir) == before
    assert not (target_dir.parent / "fatwa.staging").exists()


def test_publish_validation_failure_keeps_snapshot(tmp_path):
    base = tmp_path / "fatwa"
    records = two_records()
    files = fatwa.build_files(records, [], {"start_urls": ["https://binbaz.org.sa/x"], "rationale": "t"}, ["n"])
    snapshot.publish(base, files, fatwa.validate_fatwa_dir)
    before = snapshot_bytes(base)
    broken = dict(files)
    broken["records/binbaz-18975.json"] = broken["records/binbaz-18975.json"].replace(b"\"belief\"", b"\"worship\"")
    with pytest.raises(SnapshotError):
        snapshot.publish(base, broken, fatwa.validate_fatwa_dir)
    assert snapshot_bytes(base) == before


def current_collections():
    out = []
    for base in (REAL, STAGING):
        try:
            schema = json.loads((base / "index.json").read_bytes()).get("schema")
        except (OSError, ValueError):
            continue
        if schema == fatwa.INDEX_SCHEMA:
            out.append(base)
    return out


REAL_DIRS = current_collections()
real = pytest.mark.skipif(not REAL_DIRS, reason="no fatwa collection in the current schema")


@real
@pytest.mark.parametrize("base", REAL_DIRS or [None])
def test_real_snapshot_has_100_unique_valid_records(base):
    REAL = base
    summary = fatwa.validate_fatwa_dir(REAL)
    index = json.loads((REAL / "index.json").read_bytes())
    ids = [e["id"] for e in index["records"]]
    assert summary["count"] == len(ids) == len(set(ids)) == 100
    assert set(summary["topics"]) == set(fatwa.TOPICS) and all(summary["topics"].values())
    numbers = [e["id"].split("-", 1)[1] for e in index["records"]]
    assert len(set(numbers)) == 100
    assert all(e["source_url"].startswith("https://binbaz.org.sa/fatwas/") for e in index["records"])
    for entry in index["exclusions"]:
        assert entry["url"].startswith("https://binbaz.org.sa/") and entry["reason"]


@real
@pytest.mark.skipif(not CACHE.exists(), reason="no fatwa cache")
@pytest.mark.parametrize("base", REAL_DIRS or [None])
def test_real_snapshot_spot_checks_against_cached_raw(base):
    REAL = base
    index = json.loads((REAL / "index.json").read_bytes())
    entries = index["records"]
    fetcher = Fetcher(CACHE, offline=True)
    noted = [e for e in entries if json.loads((REAL / e["file"]).read_bytes())["notes"]]
    for entry in [entries[0], entries[len(entries) // 2], entries[-1]] + noted:
        record = snapshot.read_verified(REAL, entry["file"], entry["sha256"])
        cached = fetcher.cached(record["source"]["url"])
        assert cached is not None
        doc = cached.text()
        parsed = fatwa.parse_page(doc)
        fatwa.check_against_raw(record, parsed["article_html"])
        assert record["raw_sha256"] == snapshot.bytes_hash(parsed["article_html"].encode("utf-8"))
        assert record["source"]["retrieved_at"] == cached.retrieved_at
        assert record["question"] == parsed["question"] and record["answer"] == parsed["answer"] and record["notes"] == parsed["notes"]
        raw_answer = fatwa.raw_segments(fatwa.article_fragments(parsed["article_html"])["answer"])
        mine = [" ".join(fatwa.paragraph_text(p).split()) for p in record["answer"]]
        assert mine[0] == raw_answer[0] and mine[-1] == raw_answer[-1] and mine[len(mine) // 2] == raw_answer[len(raw_answer) // 2]
    fetcher.close()


RAW_NOTE = re.compile(r'<li data-footnote-id="[^"]+" id="footnote-([0-9]+)"><cite>(.*?)</cite></li>', re.S)
RAW_REF = re.compile(r'<a href="#footnote-([0-9]+)" id="footnote-marker-[0-9]+-[0-9]+" rel="footnote">(\[[0-9]+\])</a>')
NOTE_2_ITEM = re.compile(r'<li data-footnote-id="cgsq3" id="footnote-2">.*?</li>', re.S)
MARKER_3 = '<sup data-footnote-id="8xejw"><a href="#footnote-3" id="footnote-marker-3-1" rel="footnote">[3]</a></sup>'


def record_from_doc(doc, url=URL_19825, topic="worship"):
    parsed = fatwa.parse_page(doc)
    return fatwa.build_record(parsed, url, "2026-10-06T03:50:00+00:00", topic), parsed


def noterefs(record):
    return [(r["note"], r["text"]) for field in ("question", "answer") for p in record[field] for r in p if r["kind"] == "noteref"]


def rehash(record):
    record["content_sha256"] = snapshot.content_hash({k: v for k, v in record.items() if k != "content_sha256"})
    return record


def test_19825_notes_identity_order_and_links_match_raw():
    doc = page("19825.html")
    record, parsed = record_for("19825.html", URL_19825, "worship")
    fatwa.check_against_raw(record, parsed["article_html"])
    raw_notes = [(n, " ".join(html.unescape(t).split())) for n, t in RAW_NOTE.findall(doc)]
    assert [n for n, _ in raw_notes] == ["1", "2", "3"]
    assert [(n["id"], " ".join(fatwa.note_text(n).split())) for n in record["notes"]] == raw_notes
    assert noterefs(record) == RAW_REF.findall(doc) == [("1", "[1]"), ("2", "[2]"), ("3", "[3]")]
    assert {"kind": "noteref", "text": "[1]", "note": "1"} in record["answer"][1]
    ids = {n["id"] for n in record["notes"]}
    assert all(note in ids for note, _ in noterefs(record))
    flat = [" ".join(fatwa.paragraph_text(p).split()) for p in record["answer"]]
    assert not any(text in flat for _, text in raw_notes)
    assert fatwa.unmatched_markers(record) == []
    fatwa.validate_record(record)
    assert record["schema"] == "balligh.library.fatwa/2"


def test_marker_without_note_stays_text_and_is_reported(tmp_path):
    doc = page("19825.html")
    assert len(NOTE_2_ITEM.findall(doc)) == 1
    record, parsed = record_from_doc(NOTE_2_ITEM.sub("", doc))
    fatwa.check_against_raw(record, parsed["article_html"])
    assert [n["id"] for n in record["notes"]] == ["1", "3"]
    assert noterefs(record) == [("1", "[1]"), ("3", "[3]")]
    assert any(r["kind"] == "text" and "[2]" in r["text"] for r in record["answer"][1])
    assert fatwa.unmatched_markers(record) == ["[2]"]
    base = write_dir(tmp_path, [record])
    summary = fatwa.validate_fatwa_dir(base, raw={record["id"]: parsed["article_html"]})
    assert summary["unmatched_markers"] == {"binbaz-19825": ["[2]"]}
    assert summary["records_with_notes"] == 1 and summary["notes"] == 2 and summary["noterefs"] == 2


def test_note_without_marker_is_kept_unreferenced():
    doc = page("19825.html")
    assert MARKER_3 in doc
    record, parsed = record_from_doc(doc.replace(MARKER_3, ""))
    fatwa.check_against_raw(record, parsed["article_html"])
    assert [n["id"] for n in record["notes"]] == ["1", "2", "3"]
    assert noterefs(record) == [("1", "[1]"), ("2", "[2]")]
    assert fatwa.note_text(record["notes"][2]).startswith("نشر في (مجلة الدعوة)")


def test_notes_are_never_merged_or_invented():
    doc = page("19825.html")
    two = doc.replace("<cite>أخرجه البخاري في (فضائل القرآن)", "<p>فقرة أولى</p><p>فقرة ثانية</p><cite>أخرجه البخاري في (فضائل القرآن)", 1)
    with pytest.raises(SnapshotError, match="never merged"):
        fatwa.parse_page(two)
    with pytest.raises(SnapshotError, match="duplicate footnote"):
        fatwa.parse_page(doc.replace('id="footnote-2"', 'id="footnote-1"', 1))
    record, parsed = record_for("19825.html", URL_19825, "worship")
    assert len(record["notes"]) == len(RAW_NOTE.findall(doc)) == 3
    dup = copy.deepcopy(record)
    dup["notes"][1]["id"] = "1"
    with pytest.raises(SnapshotError, match="duplicate note id"):
        fatwa.validate_record(rehash(dup))
    dangling = copy.deepcopy(record)
    dangling["notes"] = dangling["notes"][:2]
    with pytest.raises(SnapshotError, match="not in notes"):
        fatwa.validate_record(rehash(dangling))
    with pytest.raises(SnapshotError, match="note"):
        fatwa.check_against_raw(dangling, parsed["article_html"])
    merged = copy.deepcopy(record)
    merged["notes"][0]["runs"][0]["text"] += " " + fatwa.note_text(merged["notes"][1])
    del merged["notes"][1]
    with pytest.raises(SnapshotError):
        fatwa.check_against_raw(rehash(merged), parsed["article_html"])
    flattened = copy.deepcopy(record)
    flattened["answer"] = flattened["answer"] + [n["runs"] for n in flattened["notes"]]
    with pytest.raises(SnapshotError, match="paragraphs"):
        fatwa.check_against_raw(rehash(flattened), parsed["article_html"])


def test_hostile_footnote_markup_is_inert():
    doc = page("19825.html")
    doc = doc.replace("<cite>أخرجه البخاري في (فضائل القرآن)", '<cite><script>alert(1)</script><a href="javascript:steal()" onclick="x()">أخرجه</a><img src="https://evil.example/x.png" onerror="leak()"> البخاري في (فضائل القرآن)', 1)
    doc = doc.replace('<a href="#footnote-2" id="footnote-marker-2-1" rel="footnote">', '<a href="javascript:evil()" rel="footnote">', 1)
    record, parsed = record_from_doc(doc)
    fatwa.check_against_raw(record, parsed["article_html"])
    fatwa.validate_record(record)
    blob = json.dumps(record, ensure_ascii=False)
    for leak in ("alert", "script", "javascript", "onclick", "onerror", "evil", "steal", "<a", "<img", "href"):
        assert leak not in blob, leak
    assert fatwa.note_text(record["notes"][0]).startswith("أخرجه البخاري في (فضائل القرآن)")
    assert noterefs(record) == [("1", "[1]"), ("3", "[3]")]
    assert fatwa.unmatched_markers(record) == ["[2]"]


def case_insensitive(tmp_path: Path) -> bool:
    (tmp_path / "CaseProbe").write_bytes(b"")
    return (tmp_path / "caseprobe").exists()


@pytest.mark.parametrize("rel", ["content/library", "content/library/fatwa", "CONTENT/Library/Fatwa", "content/library/x/../fatwa", "content", "."])
def test_out_inside_or_over_content_library_exits_2(rel, monkeypatch, capsys, tmp_path):
    importer = load_importer()
    monkeypatch.setattr(importer, "run", lambda *a, **k: pytest.fail("the import must not start"))
    if rel != rel.lower() and not case_insensitive(tmp_path):
        assert importer.refused_out(APP / rel) is None
        return
    live = APP / "content" / "library"
    before = sorted(p.name for p in live.iterdir()) if live.exists() else None
    assert importer.main(["--out", str(APP / rel), "--offline"]) == 2
    assert '"ok": false' in capsys.readouterr().out
    assert (sorted(p.name for p in live.iterdir()) if live.exists() else None) == before


def test_default_out_is_staging():
    importer = load_importer()
    assert importer.TARGET_DIR == APP / "var" / "library-staging" / "fatwa"
    assert importer.refused_out(importer.TARGET_DIR) is None


def test_short_import_exits_nonzero_and_leaves_out_untouched(tmp_path, monkeypatch, capsys):
    importer = load_importer()
    transport, _ = mock_site()
    out = tmp_path / "staging" / "fatwa"
    run_import(importer, tmp_path / "cache", out, transport=transport)
    fatwa.validate_fatwa_dir(out)
    before = snapshot_bytes(out)
    monkeypatch.setattr(importer, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(importer, "CATEGORIES", CATS)
    monkeypatch.setattr(importer, "SEEDS", [])
    assert importer.main(["--out", str(out), "--offline"]) == 1
    assert '"ok": false' in capsys.readouterr().out
    assert snapshot_bytes(out) == before
    assert not (out.parent / "fatwa.staging").exists()
    monkeypatch.setattr(importer, "CACHE_DIR", tmp_path / "empty-cache")
    assert importer.main(["--out", str(out), "--offline"]) == 1
    assert snapshot_bytes(out) == before


def test_offline_reimport_into_second_dir_is_byte_identical(tmp_path):
    importer = load_importer()
    transport, calls = mock_site()
    first, second = tmp_path / "a" / "fatwa", tmp_path / "b" / "fatwa"
    run_import(importer, tmp_path / "cache", first, transport=transport)
    made = len(calls)
    summary = run_import(importer, tmp_path / "cache", second, offline=True)
    assert summary["network_requests"] == 0 and len(calls) == made
    assert snapshot_bytes(first) == snapshot_bytes(second)
    index = json.loads(snapshot_bytes(second)["index.json"])
    assert index["schema"] == "balligh.library.fatwa.index/2"
    assert all("audience_reason" in e for e in index["records"])


def test_curated_selection_is_explicit_and_reasoned():
    importer = load_importer()
    ids = [c["id"] for c in importer.CURATED]
    assert len(ids) == len(set(ids)) == 100
    assert all(c["topic"] in fatwa.TOPICS and c["reason"].strip() and fatwa.fatwa_id(c["url"]) == c["id"] for c in importer.CURATED)
    replaced = {r["id"] for r in importer.REPLACED}
    assert replaced and not replaced & {f"binbaz-{i}" for i in ids} and all(r["reason"].strip() for r in importer.REPLACED)
    assert {"18975", "19825"} <= set(ids)
    assert all(fatwa.fatwa_id(u) is None and u.startswith("https://binbaz.org.sa/categories/") for u in importer.CURATION_LISTINGS)


@pytest.mark.skipif(not (STAGING / "index.json").exists(), reason="no staging fatwa collection")
def test_staging_index_carries_reasons_and_replacements():
    importer = load_importer()
    index = json.loads((STAGING / "index.json").read_bytes())
    if index["selection"].get("mode") != "curated":
        pytest.skip("staging collection is not the curated one")
    assert [e["id"] for e in index["records"]] == sorted((f"binbaz-{c['id']}" for c in importer.CURATED), key=lambda r: ([e["id"] for e in index["records"]].index(r)))
    assert {e["id"] for e in index["records"]} == {f"binbaz-{c['id']}" for c in importer.CURATED}
    reasons = {f"binbaz-{c['id']}": c["reason"] for c in importer.CURATED}
    assert all(e["audience_reason"] == reasons[e["id"]] for e in index["records"])
    assert [r["id"] for r in index["selection"]["replaced"]] == [r["id"] for r in importer.REPLACED]
