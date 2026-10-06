import hashlib
import json
from pathlib import Path

CONTENT = Path(__file__).resolve().parents[2] / "content"
SOURCE_ID = "src-g1-local-note-ar"
VERSION = "g1-fixture-1"
FIDELITY_VERSION = "g2-fixture-1"
FIDELITY_SOURCES = [
    ("src-g2-negation-ar", "g2-negation-ar.txt", "نص اختباري: النفي في قواعد مشاركة الملفات"),
    ("src-g2-condition-ar", "g2-condition-ar.txt", "نص اختباري: الشرط في النقل من المقالات"),
    ("src-g2-exception-ar", "g2-exception-ar.txt", "نص اختباري: الاستثناء في مراجعة الترجمة"),
]


def sha(t: str) -> str:
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def fidelity_source(source_id: str, file_name: str, title: str) -> dict:
    text = (CONTENT / "sources" / "texts" / file_name).read_text(encoding="utf-8")
    return {
        "id": source_id,
        "kind": "local_text",
        "publisher": None,
        "title": title,
        "canonical_url": None,
        "local_reference": f"texts/{file_name}",
        "source_version": FIDELITY_VERSION,
        "retrieved_at": "2026-10-06T01:40:00+03:00",
        "rights_url": None,
        "rights_status": "team_authored_test_text",
        "content_sha256": sha(text),
        "language": "ar",
        "attribution_status": "local_test_fixture_no_external_author",
        "is_test_data": True,
        "provenance_note": "Neutral technical text written for G2 developer fidelity checks (negation, condition, "
        "exception). Not religious content, not taken from any publication, not reviewed.",
    }


def main() -> None:
    text = (CONTENT / "sources" / "texts" / "g1-local-note-ar.txt").read_text(encoding="utf-8")
    manifest = {
        "manifest_version": 1,
        "note": "Local registry. Every entry here is test data unless stated otherwise.",
        "sources": [
            {
                "id": SOURCE_ID,
                "kind": "local_text",
                "publisher": None,
                "title": "نص اختباري محلي: الإحالة والنقل والترجمة",
                "canonical_url": None,
                "local_reference": "texts/g1-local-note-ar.txt",
                "source_version": VERSION,
                "retrieved_at": "2026-10-05T23:00:00+03:00",
                "rights_url": None,
                "rights_status": "team_authored_test_text",
                "content_sha256": sha(text),
                "language": "ar",
                "attribution_status": "local_test_fixture_no_external_author",
                "is_test_data": True,
                "provenance_note": "Neutral technical text written for the G1 workflow test. "
                "Not religious content, not taken from any publication, not reviewed.",
            },
            *(fidelity_source(*entry) for entry in FIDELITY_SOURCES),
        ],
        "team_published_lesson_hashes": [],
    }
    (CONTENT / "sources" / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )

    def span(span_id: str, exact: str) -> dict:
        start = text.index(exact)
        return {
            "id": span_id,
            "source_id": SOURCE_ID,
            "source_version": VERSION,
            "source_sha256": sha(text),
            "start_offset": start,
            "end_offset": start + len(exact),
            "segment_ids": [],
            "exact_text": exact,
            "text_sha256": sha(exact),
        }

    spans = [
        span("sp1", "الإحالة إلى المصدر عادة علمية تحفظ الأمانة."),
        span("sp2", "والنقل الحرفي يختلف عن الشرح: فالنقل يحفظ لفظ الكاتب كما هو، أما الشرح فهو فهمنا نحن لمعناه"),
        span("sp3", "فالترجمة اجتهاد في نقل المعنى، تحتاج إلى مراجعة من يتقن اللغتين قبل نشرها."),
    ]
    lesson = {
        "id": "g1-citation-lesson-en",
        "schema_version": "balligh.lesson/1",
        "is_test_data": True,
        "title": "Test lesson: citing, quoting and translating",
        "source_ids": [SOURCE_ID],
        "spans": spans,
        "input_hash": sha(text),
        "target_locale": "en",
        "level": "foundational",
        "glossary_version": "g1-fixture-glossary-1",
        "cards": [
            {
                "id": "card-1",
                "kind": "quote",
                "source_span_ids": ["sp1"],
                "text": "Citing the source is a scholarly habit that preserves trust.",
                "quote_id": "sp1",
                "derivation": "team_translation",
                "editor_note": "",
            },
            {
                "id": "card-2",
                "kind": "explanation",
                "source_span_ids": ["sp2"],
                "text": "A quotation keeps the writer's exact words. An explanation is our own understanding "
                "of their meaning, so the two should be kept clearly apart.",
                "quote_id": None,
                "derivation": "derived_explanation",
                "editor_note": "",
            },
            {
                "id": "card-3",
                "kind": "quote",
                "source_span_ids": ["sp3"],
                "text": "A translation is an effort to carry meaning into another language. Someone fluent "
                "in both languages should review it before it is published.",
                "quote_id": "sp3",
                "derivation": "team_translation",
                "editor_note": "",
            },
        ],
        "terms": [
            {
                "term_id": "t-ihala",
                "source_form": "الإحالة",
                "display_form": "citation (iḥāla)",
                "meaning": "Naming the source and the exact place of a passage so readers can check it.",
                "source_ids": [SOURCE_ID],
            },
            {
                "term_id": "t-naql",
                "source_form": "النقل الحرفي",
                "display_form": "verbatim quotation",
                "meaning": "Reproducing the writer's words exactly as written.",
                "source_ids": [SOURCE_ID],
            },
            {
                "term_id": "t-tarjama",
                "source_form": "الترجمة",
                "display_form": "translation",
                "meaning": "Carrying meaning into another language; it needs review before publication.",
                "source_ids": [SOURCE_ID],
            },
        ],
        "activity": {
            "question": "According to the source, what should happen before a translation is published?",
            "options": [
                {"id": "a", "text": "It should be published right away."},
                {"id": "b", "text": "Someone fluent in both languages should review it."},
                {"id": "c", "text": "The reference to the source should be removed."},
            ],
            "correct_option_id": "b",
            "rationale": "The source says a translation needs review by someone who masters both "
            "languages before it is published.",
            "source_span_ids": ["sp3"],
        },
        "generation": {
            "origin": "fixture",
            "provider": None,
            "requested_model": None,
            "returned_model": None,
            "prompt_version": None,
            "usage": None,
            "note": "Hand-written G1 test fixture. No AI model was called.",
        },
        "validation_findings": [],
        "presentation": {"font_scale": 1.0},
    }
    (CONTENT / "examples").mkdir(exist_ok=True)
    (CONTENT / "examples" / "g1-citation-lesson-en.json").write_text(
        json.dumps(lesson, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )


if __name__ == "__main__":
    main()
