import pytest
from pydantic import ValidationError

from balligh.hashing import sha256_text
from balligh.schemas import AudioAsset, LessonDraft, SourceRecord, TranscriptDocument, TranscriptSegment
from balligh.review import audio_matches_text
from balligh.sources import RegistryError, check_source_text


def test_fixture_is_valid(client, draft):
    r = client.post("/api/drafts/validate", json={"draft": draft})
    assert r.status_code == 200
    body = r.json()
    assert body["valid"] and body["errors"] == [] and body["status"] == "draft"


def test_unknown_source_id_rejected(draft):
    draft["spans"][0]["source_id"] = "src-does-not-exist"
    with pytest.raises(ValidationError, match="undeclared source"):
        LessonDraft.model_validate(draft)


def test_unknown_source_in_registry_reported(client, draft):
    draft["source_ids"] = ["src-missing"]
    for s in draft["spans"]:
        s["source_id"] = "src-missing"
    for t in draft["terms"]:
        t["source_ids"] = ["src-missing"]
    body = client.post("/api/drafts/validate", json={"draft": draft}).json()
    assert not body["valid"]
    assert any("unknown source_id" in e for e in body["errors"])
    assert body["status"] == "needs_correction"


def test_unknown_span_id_rejected(draft):
    draft["cards"][0]["source_span_ids"] = ["sp-nope"]
    with pytest.raises(ValidationError, match="unknown span ids"):
        LessonDraft.model_validate(draft)


def test_activity_unknown_span_rejected(draft):
    draft["activity"]["source_span_ids"] = ["sp-nope"]
    with pytest.raises(ValidationError, match="activity references unknown span"):
        LessonDraft.model_validate(draft)


def test_mismatched_range_detected(client, draft):
    draft["spans"][0]["start_offset"] += 1
    body = client.post("/api/drafts/validate", json={"draft": draft}).json()
    assert any("exact_text does not match" in e for e in body["errors"])


def test_altered_quote_text_detected(client, draft):
    sp = draft["spans"][0]
    sp["exact_text"] = sp["exact_text"].replace("الأمانة", "الدقة")
    body = client.post("/api/drafts/validate", json={"draft": draft}).json()
    assert not body["valid"]
    assert any("exact_text does not match" in e for e in body["errors"])
    assert any("text_sha256" in e for e in body["errors"])


def test_range_outside_source_detected(client, draft):
    draft["spans"][0]["end_offset"] = 100000
    body = client.post("/api/drafts/validate", json={"draft": draft}).json()
    assert any("outside the source" in e for e in body["errors"])


def test_inverted_range_rejected(draft):
    draft["spans"][0]["end_offset"] = draft["spans"][0]["start_offset"]
    with pytest.raises(ValidationError):
        LessonDraft.model_validate(draft)


def test_source_version_mismatch_detected(client, draft):
    draft["spans"][0]["source_version"] = "other-version"
    body = client.post("/api/drafts/validate", json={"draft": draft}).json()
    assert any("version/hash" in e for e in body["errors"])


@pytest.mark.parametrize("loc", ["de", "AR", "zh", "zh-Hant", ""])
def test_undeclared_locale_rejected(client, draft, loc):
    draft["target_locale"] = loc
    r = client.post("/api/drafts/validate", json={"draft": draft})
    assert r.status_code == 422


def test_card_text_over_limit_rejected(client, draft):
    draft["cards"][0]["text"] = "x" * 2001
    assert client.post("/api/drafts/validate", json={"draft": draft}).status_code == 422


def test_more_than_three_cards_rejected(draft):
    draft["cards"].append({**draft["cards"][0], "id": "card-4"})
    with pytest.raises(ValidationError):
        LessonDraft.model_validate(draft)


def test_source_word_limit():
    check_source_text("كلمة " * 300)
    with pytest.raises(RegistryError, match="limit is 300"):
        check_source_text("كلمة " * 301)
    with pytest.raises(RegistryError, match="empty"):
        check_source_text("   ")


def test_live_generation_metadata_not_accepted_in_g1(draft):
    draft["generation"]["provider"] = "deepseek"
    with pytest.raises(ValidationError):
        LessonDraft.model_validate(draft)
    draft["generation"] = {"origin": "live", "note": ""}
    with pytest.raises(ValidationError):
        LessonDraft.model_validate(draft)


@pytest.mark.parametrize("start,end", [(-1, 10), (10, 10), (20, 10)])
def test_bad_timestamps_rejected(start, end):
    with pytest.raises(ValidationError):
        TranscriptSegment(id="s1", start_ms=start, end_ms=end, text="x")


def test_transcript_duplicate_ids_rejected():
    seg = {"id": "s1", "start_ms": 0, "end_ms": 10, "text": "a"}
    with pytest.raises(ValidationError, match="unique"):
        TranscriptDocument(
            id="t1", source_id="src", origin="auto_caption", language="ar",
            segments=[seg, seg], original_sha256="0" * 64,
        )


BASE_SOURCE = dict(
    id="s", kind="hadith", title="t", source_version="1", retrieved_at="2026-10-05T00:00:00Z",
    rights_status="unknown", content_sha256="0" * 64, language="ar", attribution_status="x", is_test_data=True,
)


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "http://dorar.net/x",
        "https://evil.example/x",
        "https://dorar.net.evil.example/",
        "https://u:p@dorar.net/",
    ],
)
def test_source_url_policy(url):
    with pytest.raises(ValidationError, match="allowed source host"):
        SourceRecord(**BASE_SOURCE, canonical_url=url)


def test_source_url_allowed():
    rec = SourceRecord(**BASE_SOURCE, canonical_url="https://dorar.net/hadith/sharh/1")
    assert rec.canonical_url


def test_local_source_cannot_have_public_url():
    with pytest.raises(ValidationError, match="local source"):
        SourceRecord(**{**BASE_SOURCE, "kind": "local_text"}, canonical_url="https://dorar.net/x")


def test_source_timestamps():
    with pytest.raises(ValidationError):
        SourceRecord(**BASE_SOURCE, canonical_url="https://youtube.com/watch?v=x", start_ms=-5, end_ms=10)
    with pytest.raises(ValidationError, match="start_ms must be < end_ms"):
        SourceRecord(**BASE_SOURCE, canonical_url="https://youtube.com/watch?v=x", start_ms=50, end_ms=10)


def test_audio_asset_invalidated_by_text_change():
    text = "Citing the source preserves trust."
    asset = AudioAsset(text_hash=sha256_text(text), locale="en", rights_status="fixture_no_audio")
    assert asset.file_present is False
    assert audio_matches_text(asset, text)
    assert not audio_matches_text(asset, text + " ")
    assert not audio_matches_text(asset, "Citing the source preserves accuracy.")
