import hashlib
import json
from pathlib import Path

import pytest

from balligh.ingestion.json3 import Json3Error, Json3Manifest, parse_json3, select_segments

FIXTURES = Path(__file__).parent / "fixtures" / "json3"
SAMPLES = {
    "balligh-sample-a.ar.json3": "fa633e5a977a814c6defaa2a4be9c7e38ccf04e4a1627c96ab1355786d3f1bf9",
    "balligh-sample-b.ar.json3": "e4d80726873f62cf3b7a8a9dc5ebc88e697f963de5c15617c525c40e67f34989",
}
FIRST_TEXT = {
    "balligh-sample-a.ar.json3": "هذا نص تجريبي كتبه فريق بلّغ لاختبار قراءة ملفات الترجمة المصاحبة. (1)",
    "balligh-sample-b.ar.json3": "هذا ملف تجريبي ثانٍ من تأليف فريق بلّغ لاختبار التوقيت والمقاطع. (1)",
}


def manifest(name: str = "doc") -> Json3Manifest:
    return Json3Manifest(document_id=name, source_id="src-unverified-sample", origin="auto_caption", language="ar")


@pytest.mark.parametrize("name", SAMPLES)
def test_samples_parse_structurally(name):
    raw = (FIXTURES / name).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == SAMPLES[name], "fixture differs from the authored original"
    doc = parse_json3(raw, manifest(name.split(".")[0]))
    assert doc.original_sha256 == SAMPLES[name]
    assert doc.review_state == "unreviewed"
    assert len(doc.segments) > 300
    assert all(0 <= s.start_ms < s.end_ms for s in doc.segments)
    assert len({s.id for s in doc.segments}) == len(doc.segments)
    again = parse_json3(raw, manifest(name.split(".")[0]))
    assert [s.id for s in again.segments] == [s.id for s in doc.segments]
    events = json.loads(raw)["events"]
    first = doc.segments[0]
    idx = int(first.id[2:])
    assert first.start_ms == events[idx]["tStartMs"]
    assert first.end_ms == events[idx]["tStartMs"] + events[idx]["dDurationMs"]


def test_samples_carry_the_exact_authored_text():
    for name in SAMPLES:
        doc = parse_json3((FIXTURES / name).read_bytes(), manifest())
        assert doc.segments[0].text.strip() == FIRST_TEXT[name]


def ev(start, dur, text="نص"):
    return {"tStartMs": start, "dDurationMs": dur, "segs": [{"utf8": text}]}


def raw(events) -> bytes:
    return json.dumps({"events": events}, ensure_ascii=False).encode("utf-8")


@pytest.mark.parametrize(
    "events",
    [
        [ev(-5, 100)],
        [ev(0, 0)],
        [ev(0, -10)],
        [{"dDurationMs": 100, "segs": [{"utf8": "x"}]}],
        [{"tStartMs": 0, "segs": [{"utf8": "x"}]}],
        [ev("10", 100)],
    ],
)
def test_invalid_timing_rejected(events):
    with pytest.raises(Json3Error):
        parse_json3(raw(events), manifest())


def test_size_and_format_limits():
    with pytest.raises(Json3Error, match="2 MiB"):
        parse_json3(b"{" + b" " * (2 * 1024 * 1024) + b"}", manifest())
    with pytest.raises(Json3Error):
        parse_json3(b"not json", manifest())
    with pytest.raises(Json3Error, match="events"):
        parse_json3(b"{}", manifest())


def test_manifest_is_required_and_validated():
    with pytest.raises(Exception):
        Json3Manifest(document_id="d", source_id="s", origin="youtube", language="ar")
    with pytest.raises(Exception):
        Json3Manifest(document_id="d", source_id="s", origin="auto_caption", language="xx")


def test_selection_limited_to_three_minutes():
    doc = parse_json3(raw([ev(i * 60_000, 60_000) for i in range(5)]), manifest())
    assert len(select_segments(doc, "ev00000", "ev00002")) == 3
    with pytest.raises(Json3Error, match="limit"):
        select_segments(doc, "ev00000", "ev00003")
    with pytest.raises(Json3Error):
        select_segments(doc, "ev00003", "ev00001")
    with pytest.raises(Json3Error):
        select_segments(doc, "ev00000", "nope")


def test_selection_uses_actual_envelope_not_first_and_last():
    doc = parse_json3(raw([ev(0, 1000), ev(400_000, 1000), ev(1000, 1000)]), manifest())
    with pytest.raises(Json3Error, match="401000 ms"):
        select_segments(doc, "ev00000", "ev00002")
    doc2 = parse_json3(raw([ev(0, 1000), ev(5000, 1000), ev(1000, 1000)]), manifest())
    assert len(select_segments(doc2, "ev00000", "ev00002")) == 3
