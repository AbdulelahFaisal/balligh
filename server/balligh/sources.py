from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .config import MAX_SOURCE_WORDS
from .hashing import sha256_text
from .library.adapter import load_adapters
from .schemas import TEACHER_VERSION, LessonDraft, LiveGeneration, SourceRecord, SourceSpan, TeacherSource


class RegistryError(Exception):
    pass


def word_count(text: str) -> int:
    return len(text.split())


def check_source_text(text: str) -> None:
    n = word_count(text)
    if n == 0:
        raise RegistryError("source text is empty")
    if n > MAX_SOURCE_WORDS:
        raise RegistryError(f"source text has {n} words; the limit is {MAX_SOURCE_WORDS}")


@dataclass
class Registry:
    sources: dict[str, SourceRecord]
    texts: dict[str, str]
    team_published_hashes: frozenset[str] = field(default_factory=frozenset)
    adapter_errors: dict[str, str] = field(default_factory=dict)

    def get(self, source_id: str) -> SourceRecord:
        try:
            return self.sources[source_id]
        except KeyError:
            raise RegistryError(f"unknown source_id {source_id!r}") from None


def load_registry(content_dir: Path) -> Registry:
    manifest_path = content_dir / "sources" / "manifest.json"
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    base = (content_dir / "sources").resolve()
    sources: dict[str, SourceRecord] = {}
    texts: dict[str, str] = {}
    for raw in data["sources"]:
        rec = SourceRecord.model_validate(raw)
        if rec.id in sources:
            raise RegistryError(f"duplicate source id {rec.id}")
        if rec.local_reference:
            path = (base / rec.local_reference).resolve()
            if base not in path.parents:
                raise RegistryError(f"local_reference escapes the sources directory: {rec.id}")
            text = path.read_text(encoding="utf-8")
            if sha256_text(text) != rec.content_sha256:
                raise RegistryError(f"content hash mismatch for {rec.id}")
            check_source_text(text)
            texts[rec.id] = text
        sources[rec.id] = rec
    published = frozenset(data.get("team_published_lesson_hashes", []))
    try:
        adapted = load_adapters(content_dir / "library", frozenset(sources))
        adapter_errors = adapted.errors
    except Exception as e:
        adapted, adapter_errors = None, {"adapters": f"lesson adapters unavailable: {type(e).__name__}"}
    if adapted is not None:
        for sid, rec in adapted.records.items():
            if sid in sources:
                adapter_errors[sid] = "adapter id collides with an existing source"
                continue
            sources[sid] = rec
            texts[sid] = adapted.texts[sid]
    return Registry(sources=sources, texts=texts, team_published_hashes=published, adapter_errors=adapter_errors)


TEACHER_PREFIX = "teacher-"
TEACHER_RIGHTS = "teacher_supplied"
TEACHER_MAX_CHARS = 4000
# Arabic letters only: no Arabic punctuation (، ؛ ؟), Arabic-Indic digits, tatweel or diacritics.
_ARABIC_LETTER = re.compile("[\u0621-\u063A\u0641-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06EE\u06EF\u06FA-\u06FC\u06FF\u0750-\u077F\uFB50-\uFDFB\uFE70-\uFEFC]")
_LATIN_LETTER = re.compile("[A-Za-z]")


def is_arabic_text(text: str) -> bool:
    """The shared teacher-text language rule: some Arabic letters, and no more Latin letters than Arabic ones."""
    arabic = len(_ARABIC_LETTER.findall(text))
    return arabic > 0 and arabic >= len(_LATIN_LETTER.findall(text))


def teacher_text_errors(text: str) -> list[str]:
    """Bounds and language for teacher text, applied at every snapshot boundary (derive, generation, import)."""
    errors: list[str] = []
    words = word_count(text)
    if words == 0 or words > MAX_SOURCE_WORDS:
        errors.append(f"teacher source: the text must have 1 to {MAX_SOURCE_WORDS} words")
    if len(text) > TEACHER_MAX_CHARS:
        errors.append(f"teacher source: the text must have at most {TEACHER_MAX_CHARS} characters")
    if not is_arabic_text(text):
        errors.append("teacher source: the text must be Arabic")
    return errors


def teacher_identity(text: str) -> tuple[str, str]:
    sha = sha256_text(text)
    return f"{TEACHER_PREFIX}{sha[:16]}", sha


def teacher_snapshot_errors(source: TeacherSource, registry: Registry) -> list[str]:
    errors: list[str] = []
    derived_id, sha = teacher_identity(source.text)
    if source.content_sha256 != sha:
        errors.append("teacher source: content_sha256 does not match its text")
    if source.id != derived_id:
        errors.append("teacher source: id is not derived from its text")
    if source.version != TEACHER_VERSION:
        errors.append("teacher source: unsupported version")
    if source.id in registry.sources:
        errors.append("teacher source: id collides with a library source")
    errors.extend(teacher_text_errors(source.text))
    return errors


def teacher_record(source: TeacherSource) -> SourceRecord:
    return SourceRecord(
        id=source.id,
        kind="local_text",
        publisher=None,
        title=source.title or "Teacher-supplied text",
        local_reference="embedded-teacher-text",
        source_version=source.version,
        retrieved_at=datetime(1970, 1, 1, tzinfo=timezone.utc),
        rights_status=TEACHER_RIGHTS,
        content_sha256=source.content_sha256,
        language="ar",
        attribution_status="teacher_claim",
        is_test_data=False,
        provenance_note="Teacher-supplied text; not verified by Balligh."
        + (f" Reference given by the teacher (not verified): {source.declared_reference}" if source.declared_reference else ""),
    )


def with_teacher_source(registry: Registry, source: TeacherSource) -> Registry:
    """A request-local registry: the global one is never mutated."""
    return Registry(
        sources={**registry.sources, source.id: teacher_record(source)},
        texts={**registry.texts, source.id: source.text},
        team_published_hashes=registry.team_published_hashes,
        adapter_errors=registry.adapter_errors,
    )


def registry_for(draft: LessonDraft, registry: Registry) -> tuple[Registry, list[str]]:
    source = draft.teacher_source
    if source is None:
        if any(sid.startswith(TEACHER_PREFIX) for sid in draft.source_ids):
            return registry, ["the draft names a teacher source but does not embed its text"]
        return registry, []
    errors = teacher_snapshot_errors(source, registry)
    if errors:
        return registry, errors
    if draft.source_ids != [source.id]:
        return registry, ["a teacher-text lesson must use exactly its embedded teacher source"]
    return with_teacher_source(registry, source), []


def validate_span(span: SourceSpan, registry: Registry) -> list[str]:
    errors: list[str] = []
    try:
        rec = registry.get(span.source_id)
    except RegistryError as e:
        return [f"span {span.id}: {e}"]
    if span.source_version != rec.source_version or span.source_sha256 != rec.content_sha256:
        errors.append(f"span {span.id}: source version/hash does not match the registry")
    text = registry.texts.get(rec.id)
    if text is None:
        errors.append(f"span {span.id}: source {rec.id} has no local text to verify against")
        return errors
    if span.end_offset > len(text):
        errors.append(f"span {span.id}: range {span.start_offset}-{span.end_offset} is outside the source")
        return errors
    if text[span.start_offset:span.end_offset] != span.exact_text:
        errors.append(f"span {span.id}: exact_text does not match the source range")
    if sha256_text(span.exact_text) != span.text_sha256:
        errors.append(f"span {span.id}: text_sha256 does not match exact_text")
    return errors


def live_identity_errors(draft: LessonDraft, known: list[SourceRecord]) -> list[str]:
    if not isinstance(draft.generation, LiveGeneration):
        return []
    if len(draft.source_ids) != 1:
        return ["a live AI draft must use exactly one registered source"]
    if not known:
        return []
    registered = known[0].content_sha256
    errors: list[str] = []
    if draft.input_hash != registered:
        errors.append("input_hash does not match the registered source hash")
    if draft.generation.source_sha256 != registered:
        errors.append("generation.source_sha256 does not match the registered source hash")
    return errors


def blank_text_errors(draft: LessonDraft) -> list[str]:
    a = draft.activity
    fields = [("title", draft.title), ("activity question", a.question), ("activity rationale", a.rationale)]
    fields += [(f"card {c.id} text", c.text) for c in draft.cards]
    fields += [(f"term {t.term_id} display_form", t.display_form) for t in draft.terms]
    fields += [(f"term {t.term_id} meaning", t.meaning) for t in draft.terms]
    fields += [(f"activity option {o.id} text", o.text) for o in a.options]
    return [f"{name} is blank" for name, value in fields if not value.strip()]


def validate_draft(draft: LessonDraft, registry: Registry) -> list[str]:
    registry, errors = registry_for(draft, registry)
    known: list[SourceRecord] = []
    for sid in draft.source_ids:
        rec = registry.sources.get(sid)
        if rec is None:
            errors.append(f"unknown source_id {sid!r}")
        else:
            known.append(rec)
    test_sources = [rec.id for rec in known if rec.is_test_data]
    if test_sources and not draft.is_test_data:
        errors.append(f"is_test_data must be true: the lesson uses registered test source(s) {', '.join(test_sources)}")
    errors.extend(live_identity_errors(draft, known))
    for span in draft.spans:
        errors.extend(validate_span(span, registry))
    return errors
