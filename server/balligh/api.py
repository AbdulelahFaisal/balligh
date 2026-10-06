from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

import httpx
from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import __version__
from .assistant import AssistantService, assistant_router, load_site_help
from .config import LOCALES, MAX_IMPORT_BYTES, PRODUCT_PROVIDER, RTL_LOCALES, Settings, load_settings
from .export_html import render_lesson_html
from .fatwa_translation import machine_translation as fatwa_machine_translation
from .fatwa_translation import published_resolver
from .hashing import lesson_hash
from .ledger import Ledger
from .lesson_pipeline import (
    GENERATION_LOCALES,
    ClientDisconnected,
    GenerateRequest,
    GenerationError,
    GenerationService,
    load_glossary,
    run_until_disconnected,
)
from .library.catalog import Library, LibraryError
from .library.snapshot import SnapshotError
from .review import acknowledge, review_status, strip_imported_claims
from .routes_learn import router as learn_router
from .routes_quran_audio import router as quran_audio_router
from .routes_quran_audio import state as quran_audio_state
from .config import MAX_SOURCE_WORDS
from .lesson_pipeline import MAX_SPAN_CHARS, MAX_SPANS, segment_source
from .quran_match import find_quran
from .schemas import (
    TEACHER_MAX_CHARS,
    TEACHER_MAX_REFERENCE,
    TEACHER_MAX_TITLE,
    TEACHER_VERSION,
    LessonDraft,
    ReviewRecord,
    TeacherSource,
)
from .sources import Registry, blank_text_errors, is_arabic_text, load_registry, registry_for, teacher_identity, validate_draft, word_count

EXPORT_FORMAT = "balligh.export/1"


class DraftIn(BaseModel):
    draft: LessonDraft
    review: Optional[ReviewRecord] = None


class TeacherSourceIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(default="", max_length=TEACHER_MAX_TITLE)
    text: str = Field(max_length=20000)
    declared_reference: str = Field(default="", max_length=TEACHER_MAX_REFERENCE)


def teacher_text_problem(text: str) -> Optional[tuple[str, str]]:
    if not text.strip():
        return "empty_text", "Paste an Arabic text first."
    if len(text) > TEACHER_MAX_CHARS:
        return "too_many_chars", f"The text must have at most {TEACHER_MAX_CHARS} characters."
    if word_count(text) > MAX_SOURCE_WORDS:
        return "too_many_words", f"The text must have at most {MAX_SOURCE_WORDS} words."
    if not is_arabic_text(text):
        return "not_arabic", "Balligh prepares lessons from Arabic texts. Paste an Arabic text."
    segments = segment_source(text)
    if not segments or len(segments) > MAX_SPANS or any(len(s.text) > MAX_SPAN_CHARS for s in segments):
        return "too_fragmented", f"The text must split into 1 to {MAX_SPANS} sentences."
    return None


class AcknowledgeIn(BaseModel):
    draft: LessonDraft
    reviewer_label: str = Field(min_length=1, max_length=80)
    reviewer_role_self_declared: str = Field(default="", max_length=80)
    notes: str = Field(default="", max_length=1000)
    confirmed_compared_with_source: bool


def _errors(e: ValidationError) -> list[str]:
    return [f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}" for err in e.errors()]


def load_generation_evidence(content_dir: Path) -> dict[str, Any]:
    try:
        data = json.loads((content_dir / "evidence" / "generation-tested.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    locales = data.get("locales") if isinstance(data, dict) else None
    return locales if isinstance(locales, dict) else {}


def create_app(
    settings: Settings | None = None,
    transport: Optional[httpx.AsyncBaseTransport] = None,
    sleep: Optional[Callable[[float], Awaitable[None]]] = None,
) -> FastAPI:
    settings = settings or load_settings()
    registry: Registry = load_registry(settings.content_dir)
    examples_dir = settings.content_dir / "examples"
    tested = load_generation_evidence(settings.content_dir)
    service = GenerationService(
        settings=settings,
        registry=registry,
        glossary=load_glossary(settings.content_dir),
        ledger=Ledger(settings.ledger_dir) if settings.ledger_dir else None,
        transport=transport,
    )
    if sleep is not None:
        service.sleep = sleep

    library = Library(settings.content_dir / "library")
    translations_root = settings.content_dir / "translations" / "fatwa"
    assistant = AssistantService(
        settings=settings,
        library=library,
        admission=service.admission,
        help=load_site_help(settings.content_dir),
        transport=transport,
    )
    if sleep is not None:
        assistant.sleep = sleep

    app = FastAPI(title="Balligh", version=__version__, docs_url=None, redoc_url=None)
    app.state.generation = service
    app.state.library = library
    app.state.assistant = assistant
    api = APIRouter(prefix="/api")

    def read_library(fn: Callable[..., dict[str, Any]], *args: Any, **kwargs: Any) -> dict[str, Any]:
        try:
            return fn(*args, **kwargs)
        except LibraryError as e:
            raise HTTPException(e.status, {"code": e.code, "message": e.message}) from None
        except SnapshotError:
            raise HTTPException(
                503, {"code": "integrity", "message": "This library item failed its integrity check and is not shown."}
            ) from None

    def check(draft: LessonDraft) -> list[str]:
        return validate_draft(draft, registry) + blank_text_errors(draft)

    def evaluate(draft: LessonDraft, review: Optional[ReviewRecord]) -> dict[str, Any]:
        errors = check(draft)
        return {
            "valid": not errors,
            "errors": errors,
            "lesson_hash": lesson_hash(draft),
            "status": review_status(draft, review, registry, errors),
        }

    @api.get("/health")
    def health() -> dict[str, Any]:
        configured = settings.generation_configured
        return {
            "status": "ok",
            "version": __version__,
            "sources_loaded": len(registry.sources),
            "generation": {
                "enabled": configured,
                "configured": configured,
                "provider": PRODUCT_PROVIDER,
                "model": settings.generation.model,
                "locales": list(GENERATION_LOCALES),
                "max_in_flight": settings.generation.max_in_flight,
                "in_flight": service.admission.active,
            },
            "provider_audio": {"enabled": settings.audio_enabled, "planned_phase": "G4"},
            "product_model": settings.product_model,
        }

    @api.get("/locales")
    def locales() -> list[dict[str, Any]]:
        return [
            {
                "locale": loc,
                "dir": "rtl" if loc in RTL_LOCALES else "ltr",
                "ui_ready": True,
                "generation_tested": loc in tested,
                "source_translation_available": False,
                "content_reviewed": False,
                "audio_tested": False,
            }
            for loc in LOCALES
        ]

    @api.get("/sources")
    def list_sources() -> list[dict[str, Any]]:
        return [rec.model_dump(mode="json") for rec in registry.sources.values()]

    @api.get("/sources/{source_id}")
    def get_source(source_id: str) -> dict[str, Any]:
        rec = registry.sources.get(source_id)
        if rec is None:
            raise HTTPException(404, f"unknown source_id {source_id!r}")
        return {"record": rec.model_dump(mode="json"), "text": registry.texts.get(source_id)}

    @api.get("/library")
    def library_summary() -> dict[str, Any]:
        return read_library(library.summary)

    @api.get("/library/quran")
    def library_quran() -> dict[str, Any]:
        return read_library(library.quran_overview)

    @api.get("/library/quran/{number}")
    def library_surah(number: int, locale: str = "ar", tafsir: Optional[str] = None) -> dict[str, Any]:
        return read_library(library.surah, number, locale, tafsir)

    def listing(
        name: str, topic: Optional[str], q: Optional[str], locale: str, page: int, page_size: int
    ) -> dict[str, Any]:
        return read_library(
            library.listing, name, topic=topic, q=q, locale=locale, page=page, page_size=page_size
        )

    @api.get("/library/fatwas")
    def library_fatwas(
        topic: Optional[str] = None, q: Optional[str] = None, locale: str = "ar", page: int = 1, page_size: int = 20
    ) -> dict[str, Any]:
        return listing("fatwa", topic, q, locale, page, page_size)

    @api.get("/library/fatwas/{record_id}")
    def library_fatwa(record_id: str, locale: str = "ar") -> dict[str, Any]:
        data = read_library(library.record, "fatwa", record_id, locale)
        # AI-assisted full translations live outside the publisher record and are served only when still valid.
        rec = data.get("record") or {}
        quran_dir = settings.content_dir / "library" / "quran"
        data["machine_translation"] = (
            fatwa_machine_translation(translations_root, rec, locale, published_resolver(quran_dir, rec, locale))
            if locale != "ar" else None
        )
        return data

    @api.get("/library/hadith")
    def library_hadiths(
        topic: Optional[str] = None, q: Optional[str] = None, locale: str = "ar", page: int = 1, page_size: int = 20
    ) -> dict[str, Any]:
        return listing("hadith", topic, q, locale, page, page_size)

    @api.get("/library/hadith/{record_id}")
    def library_hadith(record_id: str, locale: str = "ar") -> dict[str, Any]:
        return read_library(library.record, "hadith", record_id, locale)

    @api.get("/examples")
    def list_examples() -> list[dict[str, Any]]:
        out = []
        for p in sorted(examples_dir.glob("*.json")):
            d = LessonDraft.model_validate_json(p.read_text(encoding="utf-8"))
            out.append({"id": d.id, "title": d.title, "target_locale": d.target_locale, "source_ids": d.source_ids})
        return out

    @api.get("/examples/{example_id}")
    def get_example(example_id: str) -> dict[str, Any]:
        for p in examples_dir.glob("*.json"):
            d = LessonDraft.model_validate_json(p.read_text(encoding="utf-8"))
            if d.id == example_id:
                return {"draft": d.model_dump(mode="json"), **evaluate(d, None)}
        raise HTTPException(404, "unknown example")

    @api.get("/teacher-sources/limits")
    def teacher_limits() -> dict[str, Any]:
        return {
            "max_words": MAX_SOURCE_WORDS,
            "max_chars": TEACHER_MAX_CHARS,
            "max_sentences": MAX_SPANS,
            "max_title_chars": TEACHER_MAX_TITLE,
            "max_reference_chars": TEACHER_MAX_REFERENCE,
        }

    @api.post("/teacher-sources/derive")
    def derive_teacher_source(body: TeacherSourceIn) -> JSONResponse:
        # Stateless: the server derives identity from the exact text and keeps nothing.
        problem = teacher_text_problem(body.text)
        if problem:
            return JSONResponse({"detail": {"code": problem[0], "message": problem[1]}}, status_code=422)
        source_id, sha = teacher_identity(body.text)
        snapshot = TeacherSource(
            id=source_id,
            version=TEACHER_VERSION,
            content_sha256=sha,
            title=body.title.strip(),
            text=body.text,
            language="ar",
            declared_reference=body.declared_reference.strip(),
        )
        return JSONResponse(
            {
                "snapshot": snapshot.model_dump(mode="json"),
                "words": word_count(body.text),
                "chars": len(body.text),
                "sentences": len(segment_source(body.text)),
                "quran": find_quran(body.text, settings.content_dir / "library" / "quran" / "surahs"),
            }
        )

    @api.post("/drafts/validate")
    def validate(body: DraftIn) -> dict[str, Any]:
        return evaluate(body.draft, body.review)

    @api.post("/drafts/generate")
    async def generate(body: GenerateRequest, request: Request) -> JSONResponse:
        try:
            prepared = service.prepare(body)
            draft = await run_until_disconnected(request.is_disconnected, service.run(prepared))
        except GenerationError as e:
            return JSONResponse({"detail": e.detail()}, status_code=e.status)
        except ClientDisconnected:
            return JSONResponse({"detail": {"code": "cancelled", "message": "Request cancelled."}}, status_code=499)
        return JSONResponse(
            {"draft": draft.model_dump(mode="json"), "request_id": body.request_id, **evaluate(draft, None)}
        )

    @api.post("/reviews/acknowledge")
    def ack(body: AcknowledgeIn) -> dict[str, Any]:
        if not body.confirmed_compared_with_source:
            raise HTTPException(422, "confirm that you compared the draft with the source")
        errors = check(body.draft)
        if errors:
            raise HTTPException(422, {"message": "draft has validation errors", "errors": errors})
        rec = acknowledge(body.draft, body.reviewer_label, body.reviewer_role_self_declared, body.notes)
        return {"review": rec.model_dump(mode="json"), **evaluate(body.draft, rec)}

    @api.post("/export/html")
    def export_html(body: DraftIn) -> HTMLResponse:
        ev = evaluate(body.draft, body.review)
        if not ev["valid"]:
            raise HTTPException(422, {"message": "draft has validation errors", "errors": ev["errors"]})
        label = body.review.reviewer_label if body.review else None
        sources = registry_for(body.draft, registry)[0].sources
        html = render_lesson_html(body.draft, ev["status"], sources, ev["lesson_hash"], label)
        return HTMLResponse(html, headers={"Content-Disposition": 'attachment; filename="balligh-lesson.html"'})

    @api.post("/export/json")
    def export_json(body: DraftIn) -> JSONResponse:
        ev = evaluate(body.draft, body.review)
        envelope = {
            "format": EXPORT_FORMAT,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "lesson_hash": ev["lesson_hash"],
            "status_at_export": ev["status"],
            "notice": "A local acknowledgment in this file is informational. Importing it never grants "
            "acknowledgment or team approval; the importer must acknowledge again.",
            "draft": body.draft.model_dump(mode="json"),
            "local_review": body.review.model_dump(mode="json") if body.review else None,
        }
        return JSONResponse(envelope, headers={"Content-Disposition": 'attachment; filename="balligh-lesson.json"'})

    @api.post("/drafts/import")
    async def import_draft(request: Request) -> dict[str, Any]:
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_IMPORT_BYTES:
            raise HTTPException(413, "file exceeds 2 MiB")
        raw = await request.body()
        if len(raw) > MAX_IMPORT_BYTES:
            raise HTTPException(413, "file exceeds 2 MiB")
        try:
            envelope = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise HTTPException(400, "the file is not valid UTF-8 JSON") from None
        if not isinstance(envelope, dict):
            raise HTTPException(400, "the file is not a Balligh export")
        if envelope.get("format") != EXPORT_FORMAT:
            raise HTTPException(422, f"unsupported export format {str(envelope.get('format'))[:40]!r}")
        discarded = strip_imported_claims(envelope)
        draft_raw = envelope.get("draft")
        if isinstance(draft_raw, dict) and draft_raw.get("schema_version") != "balligh.lesson/1":
            raise HTTPException(422, f"unsupported lesson schema {str(draft_raw.get('schema_version'))[:40]!r}")
        try:
            draft = LessonDraft.model_validate(draft_raw)
        except ValidationError as e:
            raise HTTPException(422, {"message": "the lesson in the file is invalid", "errors": _errors(e)}) from None
        provenance_errors = validate_draft(draft, registry)
        if provenance_errors:
            raise HTTPException(
                422, {"message": "the lesson in the file does not match its sources", "errors": provenance_errors}
            )
        return {"draft": draft.model_dump(mode="json"), "discarded_claims": discarded, **evaluate(draft, None)}

    app.include_router(api)
    quran_audio_state.configure(settings.content_dir / "library")
    app.include_router(quran_audio_router)
    app.include_router(learn_router)
    app.include_router(assistant_router(assistant))

    @app.exception_handler(ValidationError)
    async def _validation(_: Request, e: ValidationError) -> JSONResponse:
        return JSONResponse({"detail": _errors(e)}, status_code=422)

    dist = settings.web_dist
    if dist.is_dir():
        index = dist / "index.html"
        dist_resolved = dist.resolve()

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str) -> FileResponse:
            if path.startswith("api/"):
                raise HTTPException(404)
            candidate = (dist / path).resolve()
            if path and dist_resolved in candidate.parents and candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(index)

    return app
