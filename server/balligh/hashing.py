import hashlib
import json
from typing import Any

from .schemas import LessonDraft


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def semantic_payload(draft: LessonDraft) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema_version": draft.schema_version,
        "title": draft.title,
        "source_ids": sorted(draft.source_ids),
        "spans": sorted(
            (
                {
                    "id": s.id,
                    "source_id": s.source_id,
                    "source_version": s.source_version,
                    "source_sha256": s.source_sha256,
                    "start_offset": s.start_offset,
                    "end_offset": s.end_offset,
                    "segment_ids": s.segment_ids,
                    "exact_text": s.exact_text,
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
    if draft.teacher_source is not None:
        payload["teacher_source"] = draft.teacher_source.model_dump()
    return payload


def lesson_hash(draft: LessonDraft) -> str:
    return "sha256:" + sha256_text(canonical_json(semantic_payload(draft)))


def source_hashes(draft: LessonDraft) -> dict[str, str]:
    out: dict[str, str] = {}
    for s in draft.spans:
        out[s.source_id] = f"{s.source_version}:{s.source_sha256}"
    return out
