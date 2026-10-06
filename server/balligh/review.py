from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Optional

from .hashing import lesson_hash, sha256_text, source_hashes
from .schemas import AudioAsset, LessonDraft, ReviewRecord
from .sources import Registry

ReviewStatus = Literal["draft", "needs_correction", "stale", "acknowledged_by_user", "team_published"]


def acknowledge(draft: LessonDraft, reviewer_label: str, role: str = "", notes: str = "") -> ReviewRecord:
    return ReviewRecord(
        lesson_hash=lesson_hash(draft),
        source_hashes=source_hashes(draft),
        glossary_version=draft.glossary_version,
        locale=draft.target_locale,
        reviewer_label=reviewer_label,
        reviewer_role_self_declared=role,
        reviewed_at=datetime.now(timezone.utc),
        notes=notes,
    )


def review_status(
    draft: LessonDraft, review: Optional[ReviewRecord], registry: Registry, errors: list[str]
) -> ReviewStatus:
    current = lesson_hash(draft)
    if current in registry.team_published_hashes:
        return "team_published"
    if errors:
        return "needs_correction"
    if review is None:
        return "draft"
    if (
        review.lesson_hash != current
        or review.source_hashes != source_hashes(draft)
        or review.glossary_version != draft.glossary_version
        or review.locale != draft.target_locale
    ):
        return "stale"
    return "acknowledged_by_user"


_APPROVAL_KEYS = ("local_review", "review", "status", "approved", "reviewed", "team_approved", "approval")


def strip_imported_claims(envelope: dict[str, Any]) -> list[str]:
    discarded: list[str] = []
    for key in _APPROVAL_KEYS:
        if key in envelope and envelope[key] not in (None, False, "", {}):
            discarded.append(key)
        envelope.pop(key, None)
    draft = envelope.get("draft")
    if isinstance(draft, dict):
        for key in _APPROVAL_KEYS:
            if key in draft:
                discarded.append(f"draft.{key}")
                draft.pop(key)
    return discarded


def audio_matches_text(asset: AudioAsset, text: str) -> bool:
    return asset.text_hash == sha256_text(text)
