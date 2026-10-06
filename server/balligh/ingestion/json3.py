from __future__ import annotations

import hashlib
import json
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from ..config import MAX_JSON3_BYTES, MAX_SEGMENT_SELECTION_MS
from ..schemas import Locale, TranscriptDocument, TranscriptSegment


class Json3Error(ValueError):
    pass


class Json3Manifest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$")
    source_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$")
    origin: Literal["manual", "asr", "auto_caption", "translated_caption"]
    language: Locale
    model_version: Optional[str] = None


def parse_json3(raw: bytes, manifest: Json3Manifest) -> TranscriptDocument:
    if len(raw) > MAX_JSON3_BYTES:
        raise Json3Error("JSON3 file exceeds 2 MiB")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise Json3Error(f"not valid UTF-8 JSON: {e}") from None
    events = data.get("events") if isinstance(data, dict) else None
    if not isinstance(events, list):
        raise Json3Error("missing 'events' list")

    segments: list[TranscriptSegment] = []
    for index, ev in enumerate(events):
        if not isinstance(ev, dict):
            raise Json3Error(f"event {index} is not an object")
        segs = ev.get("segs")
        if not segs:
            continue
        text = "".join(s.get("utf8", "") for s in segs if isinstance(s, dict)).replace("\n", " ").strip()
        if not text:
            continue
        start, dur = ev.get("tStartMs"), ev.get("dDurationMs")
        if not isinstance(start, int) or isinstance(start, bool) or not isinstance(dur, int) or isinstance(dur, bool):
            raise Json3Error(f"event {index} lacks integer tStartMs/dDurationMs")
        if start < 0 or dur <= 0:
            raise Json3Error(f"event {index} has invalid timing start={start} duration={dur}")
        segments.append(TranscriptSegment(id=f"ev{index:05d}", start_ms=start, end_ms=start + dur, text=text))

    if not segments:
        raise Json3Error("no text segments")
    return TranscriptDocument(
        id=manifest.document_id,
        source_id=manifest.source_id,
        origin=manifest.origin,
        language=manifest.language,
        model_version=manifest.model_version,
        segments=segments,
        original_sha256=hashlib.sha256(raw).hexdigest(),
        review_state="unreviewed",
    )


def select_segments(doc: TranscriptDocument, first_id: str, last_id: str) -> list[TranscriptSegment]:
    ids = [s.id for s in doc.segments]
    try:
        i, j = ids.index(first_id), ids.index(last_id)
    except ValueError:
        raise Json3Error("unknown segment id") from None
    if j < i:
        raise Json3Error("selection end precedes its start")
    chosen = doc.segments[i : j + 1]
    span = max(s.end_ms for s in chosen) - min(s.start_ms for s in chosen)
    if span > MAX_SEGMENT_SELECTION_MS:
        raise Json3Error(f"selection spans {span} ms; the limit is {MAX_SEGMENT_SELECTION_MS} ms")
    return chosen
