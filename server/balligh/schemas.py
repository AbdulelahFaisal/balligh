from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, Optional, Union, get_args

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_serializer, model_validator

from .config import LOCALES
from .urls import is_allowed_source_url

Locale = Literal["ar", "en", "ur", "zh-Hans", "id", "bn", "fr"]
assert set(get_args(Locale)) == set(LOCALES)

Sha256 = Field(pattern=r"^[0-9a-f]{64}$")
Ident = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$")
RequestId = Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

Derivation = Literal[
    "verbatim_quote",
    "team_translation",
    "derived_explanation",
    "machine_translation",
    "machine_explanation",
]
MACHINE_DERIVATIONS = frozenset({"machine_translation", "machine_explanation"})


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)


class SourceRecord(Strict):
    id: str = Ident
    kind: Literal["local_text", "quran", "quran_translation", "hadith", "fatwa", "media"]
    publisher: Optional[str] = Field(default=None, max_length=200)
    title: str = Field(min_length=1, max_length=300)
    canonical_url: Optional[str] = None
    local_reference: Optional[str] = Field(default=None, max_length=300)
    source_version: str = Field(min_length=1, max_length=80)
    retrieved_at: datetime
    rights_url: Optional[str] = None
    rights_status: str = Field(min_length=1, max_length=80)
    content_sha256: str = Sha256
    language: Locale
    attribution_status: str = Field(min_length=1, max_length=80)
    is_test_data: bool
    provenance_note: str = Field(default="", max_length=1000)
    surah: Optional[int] = Field(default=None, ge=1, le=114)
    ayah: Optional[int] = Field(default=None, ge=1)
    collection: Optional[str] = None
    hadith_number: Optional[str] = None
    grading_author: Optional[str] = None
    fatwa_id: Optional[str] = None
    scholar: Optional[str] = None
    media_url: Optional[str] = None
    speaker: Optional[str] = None
    start_ms: Optional[int] = Field(default=None, ge=0)
    end_ms: Optional[int] = Field(default=None, ge=0)
    library_record_id: Optional[str] = Field(default=None, pattern=r"^[a-z]+-[0-9]{1,12}$")
    library_collection: Optional[Literal["fatwa", "hadith"]] = None
    library_content_sha256: Optional[str] = Field(default=None, pattern=r"^sha256:[0-9a-f]{64}$")
    adapter_version: Optional[str] = Field(default=None, max_length=40)
    hadith_attribution: Optional[str] = Field(default=None, max_length=200)
    hadith_grade: Optional[str] = Field(default=None, max_length=80)
    external_check: Optional[str] = Field(default=None, max_length=400)

    @field_validator("canonical_url", "rights_url", "media_url")
    @classmethod
    def _registry_urls_only(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not is_allowed_source_url(v):
            raise ValueError("URL must be https on an allowed source host")
        return v

    @model_validator(mode="after")
    def _check(self) -> "SourceRecord":
        if self.start_ms is not None and self.end_ms is not None and not self.start_ms < self.end_ms:
            raise ValueError("start_ms must be < end_ms")
        if self.kind == "local_text" and self.canonical_url is not None:
            raise ValueError("a local source has no public URL")
        if self.canonical_url is None and self.local_reference is None:
            raise ValueError("a source needs a canonical_url or a local_reference")
        linked = (self.library_record_id, self.library_collection, self.library_content_sha256, self.adapter_version)
        if any(v is not None for v in linked):
            if any(v is None for v in linked) or self.kind != self.library_collection or self.is_test_data:
                raise ValueError("a library adapter source needs its record, collection, hash and adapter version")
        return self


class TranscriptSegment(Strict):
    id: str = Ident
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    text: str = Field(max_length=5000)

    @model_validator(mode="after")
    def _order(self) -> "TranscriptSegment":
        if not self.start_ms < self.end_ms:
            raise ValueError("segment requires 0 <= start_ms < end_ms")
        return self


class TranscriptDocument(Strict):
    id: str = Ident
    source_id: str = Ident
    origin: Literal["manual", "asr", "auto_caption", "translated_caption"]
    language: Locale
    model_version: Optional[str] = None
    segments: list[TranscriptSegment] = Field(min_length=1, max_length=5000)
    original_sha256: str = Sha256
    review_state: Literal["unreviewed", "needs_correction", "acknowledged_by_user"] = "unreviewed"

    @model_validator(mode="after")
    def _unique_ids(self) -> "TranscriptDocument":
        ids = [s.id for s in self.segments]
        if len(ids) != len(set(ids)):
            raise ValueError("segment ids must be unique")
        return self


class SourceSpan(Strict):
    id: str = Ident
    source_id: str = Ident
    source_version: str
    source_sha256: str = Sha256
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=1)
    segment_ids: list[str] = Field(default_factory=list)
    exact_text: str = Field(min_length=1, max_length=3000)
    text_sha256: str = Sha256

    @model_validator(mode="after")
    def _range(self) -> "SourceSpan":
        if not self.start_offset < self.end_offset:
            raise ValueError("span requires start_offset < end_offset")
        return self


class LessonCard(Strict):
    id: str = Ident
    kind: Literal["quote", "explanation", "term_note"]
    source_span_ids: list[str] = Field(min_length=1, max_length=5)
    text: str = Field(min_length=1, max_length=2000)
    quote_id: Optional[str] = None
    derivation: Derivation
    editor_note: str = Field(default="", max_length=1000)


class LessonTerm(Strict):
    term_id: str = Ident
    source_form: str = Field(min_length=1, max_length=120)
    display_form: str = Field(min_length=1, max_length=120)
    meaning: str = Field(min_length=1, max_length=600)
    source_ids: list[str] = Field(min_length=1)


class ActivityOption(Strict):
    id: str = Ident
    text: str = Field(min_length=1, max_length=300)


class LessonActivity(Strict):
    question: str = Field(min_length=1, max_length=500)
    options: list[ActivityOption] = Field(min_length=2, max_length=5)
    correct_option_id: str
    rationale: str = Field(min_length=1, max_length=1000)
    source_span_ids: list[str] = Field(min_length=1)

    @model_validator(mode="after")
    def _correct_exists(self) -> "LessonActivity":
        ids = [o.id for o in self.options]
        if len(ids) != len(set(ids)):
            raise ValueError("option ids must be unique")
        if self.correct_option_id not in ids:
            raise ValueError("correct_option_id must be one of the options")
        return self


class TokenUsage(Strict):
    prompt_tokens: Optional[int] = Field(default=None, ge=0)
    completion_tokens: Optional[int] = Field(default=None, ge=0)
    total_tokens: Optional[int] = Field(default=None, ge=0)
    prompt_cache_hit_tokens: Optional[int] = Field(default=None, ge=0)
    prompt_cache_miss_tokens: Optional[int] = Field(default=None, ge=0)
    reasoning_tokens: Optional[int] = Field(default=None, ge=0)


class RequestSettings(Strict):
    thinking: str = Field(min_length=1, max_length=20)
    reasoning_effort: str = Field(min_length=1, max_length=20)
    response_format: str = Field(min_length=1, max_length=40)
    max_tokens: int = Field(ge=1)


class AuthoredGeneration(Strict):
    origin: Literal["fixture", "manual"]
    provider: None = None
    requested_model: None = None
    returned_model: None = None
    prompt_version: None = None
    usage: None = None
    note: str = Field(default="", max_length=500)
    human_edited: bool = False
    last_human_edit_at: Optional[datetime] = None


class LiveGeneration(Strict):
    origin: Literal["live"]
    provider: Literal["deepseek"]
    requested_model: str = Field(min_length=1, max_length=80)
    returned_model: Optional[str] = Field(default=None, max_length=80)
    prompt_version: str = Field(min_length=1, max_length=40)
    request_id: str = RequestId
    generated_at: datetime
    source_sha256: str = Sha256
    glossary_sha256: str = Sha256
    settings: RequestSettings
    usage: Optional[TokenUsage] = None
    latency_ms: Optional[int] = Field(default=None, ge=0)
    note: str = Field(default="", max_length=500)
    human_edited: bool = False
    last_human_edit_at: Optional[datetime] = None


GenerationInfo = Annotated[Union[AuthoredGeneration, LiveGeneration], Field(discriminator="origin")]


TEACHER_VERSION = "teacher-1"
TEACHER_MAX_CHARS = 4000
TEACHER_MAX_TITLE = 120
TEACHER_MAX_REFERENCE = 300


class TeacherSource(Strict):
    """A teacher-supplied Arabic text embedded in a draft; id, version and hash derive from the exact text."""

    id: str = Field(pattern=r"^teacher-[0-9a-f]{16}$")
    version: Literal["teacher-1"]
    content_sha256: str = Sha256
    title: str = Field(default="", max_length=TEACHER_MAX_TITLE)
    text: str = Field(min_length=1, max_length=TEACHER_MAX_CHARS)
    language: Literal["ar"]
    declared_reference: str = Field(default="", max_length=TEACHER_MAX_REFERENCE)


class Presentation(Strict):
    font_scale: float = Field(default=1.0, ge=0.75, le=2.0)


class LessonDraft(Strict):
    id: str = Ident
    schema_version: Literal["balligh.lesson/1"]
    is_test_data: bool
    title: str = Field(min_length=1, max_length=200)
    source_ids: list[str] = Field(min_length=1, max_length=5)
    spans: list[SourceSpan] = Field(min_length=1, max_length=30)
    input_hash: str = Sha256
    target_locale: Locale
    level: Literal["foundational", "detailed"]
    glossary_version: str = Field(min_length=1, max_length=80)
    cards: list[LessonCard] = Field(min_length=1, max_length=3)
    terms: list[LessonTerm] = Field(default_factory=list, max_length=12)
    activity: LessonActivity
    generation: GenerationInfo
    validation_findings: list[str] = Field(default_factory=list, max_length=50)
    presentation: Presentation = Field(default_factory=Presentation)
    teacher_source: Optional[TeacherSource] = None

    @model_serializer(mode="wrap")
    def _omit_absent_teacher_source(self, handler):  # legacy drafts serialize exactly as before
        data = handler(self)
        if isinstance(data, dict) and data.get("teacher_source") is None:
            data.pop("teacher_source", None)
        return data

    @model_validator(mode="after")
    def _internal_refs(self) -> "LessonDraft":
        span_ids = {s.id for s in self.spans}
        if len(span_ids) != len(self.spans):
            raise ValueError("span ids must be unique")
        card_ids = [c.id for c in self.cards]
        if len(card_ids) != len(set(card_ids)):
            raise ValueError("card ids must be unique")
        for s in self.spans:
            if s.source_id not in self.source_ids:
                raise ValueError(f"span {s.id} references undeclared source {s.source_id}")
        for c in self.cards:
            missing = [i for i in c.source_span_ids if i not in span_ids]
            if missing:
                raise ValueError(f"card {c.id} references unknown span ids {missing}")
            if c.quote_id is not None and c.quote_id not in c.source_span_ids:
                raise ValueError(f"card {c.id} quote_id must be one of its spans")
        for t in self.terms:
            if any(i not in self.source_ids for i in t.source_ids):
                raise ValueError(f"term {t.term_id} references an undeclared source")
        if any(i not in span_ids for i in self.activity.source_span_ids):
            raise ValueError("activity references unknown span ids")
        if self.generation.origin == "live":
            relabelled = [c.id for c in self.cards if c.derivation not in MACHINE_DERIVATIONS]
            if relabelled:
                raise ValueError(f"cards {relabelled} of a live AI draft must keep a machine derivation")
        return self


class ReviewRecord(Strict):
    lesson_hash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    source_hashes: dict[str, str]
    glossary_version: str
    locale: Locale
    reviewer_label: str = Field(min_length=1, max_length=80)
    reviewer_role_self_declared: str = Field(default="", max_length=80)
    reviewed_at: datetime
    scope: Literal["whole_lesson"] = "whole_lesson"
    status: Literal["acknowledged_by_user"] = "acknowledged_by_user"
    verification: Literal["none_local_self_declared"] = "none_local_self_declared"
    notes: str = Field(default="", max_length=1000)


class AudioAsset(Strict):
    text_hash: str = Sha256
    locale: Locale
    voice_id: Optional[str] = None
    model: Optional[str] = None
    approval_hash: Optional[str] = None
    rights_status: str
    duration_ms: Optional[int] = Field(default=None, gt=0)
    pronunciation_reviewed: bool = False
    file_present: bool = False
