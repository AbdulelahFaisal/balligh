from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from ..config import MAX_SOURCE_WORDS
from ..hashing import sha256_text
from ..schemas import SourceRecord
from .catalog import Library
from .snapshot import SnapshotError, read_verified

ADAPTER_SCHEMA = "balligh.library.lesson-adapters/1"
ADAPTER_VERSION = "g4b-adapter-1"
MANIFEST_REL = ("adapters", "lesson-sources.json")
ELIGIBLE = {"fatwa": ("question", "answer", "notes"), "hadith": ("text",)}
NEVER_ELIGIBLE = ("quran", "quran_translation", "book")
RUN_KINDS = frozenset({"text", "strong", "quran", "hadith", "noteref"})
HONORIFICS = {
    "": "سبحانه وتعالى",
    "": "عز وجل",
    "": "رضي الله عنه",
    "": "رضي الله عنهم",
}
NOTES_HEADING = "الحواشي:"
PARAGRAPH_BREAK = "\n\n"
ID_PREFIX = {"fatwa": "lib-fatwa-", "hadith": "lib-hadith-"}
PUBLISHER_PREFIX = {"fatwa": "binbaz-", "hadith": "hadeethenc-"}
REPRESENTATION = (
    "fatwa: question paragraphs, then answer paragraphs, each paragraph the exact concatenation of its run texts "
    "(noteref runs keep their visible marker such as [1]); paragraphs whose text is only whitespace are omitted; "
    "paragraphs are joined by a blank line (\\n\\n). If notes exist, a blank line, the line 'الحواشي:', then one "
    "line per note in source order: '[<note id>] ' followed by the exact concatenation of its run texts. "
    "hadith: the record text field only (Prophetic wording with its narrator preamble); explanation, hints, word "
    "meanings, attribution, grade and reference are metadata and never part of the text. In both, each of "
    "U+F049, U+F055, U+F074, U+F079 is replaced by exactly the mapped words (no added spaces); any other "
    "private-use character makes the unit ineligible. No other change, trimming or normalization is applied."
)


class AdapterError(Exception):
    pass


class Ineligible(AdapterError):
    pass


@dataclass
class AdaptedSet:
    records: dict[str, SourceRecord] = field(default_factory=dict)
    texts: dict[str, str] = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)


def _private_use(ch: str) -> bool:
    o = ord(ch)
    return 0xE000 <= o <= 0xF8FF or 0xF0000 <= o <= 0x10FFFF


def map_honorifics(text: str) -> str:
    out = "".join(HONORIFICS.get(ch, ch) for ch in text)
    bad = sorted({f"U+{ord(ch):04X}" for ch in out if _private_use(ch)})
    if bad:
        raise Ineligible(f"unknown private-use glyph(s) {', '.join(bad)}")
    return out


def _runs_text(runs: Any) -> str:
    if not isinstance(runs, list):
        raise Ineligible("malformed paragraph")
    parts: list[str] = []
    for run in runs:
        if not isinstance(run, dict) or run.get("kind") not in RUN_KINDS or not isinstance(run.get("text"), str):
            raise Ineligible("unsupported run kind in the record")
        parts.append(run["text"])
    return "".join(parts)


def fatwa_text(rec: dict[str, Any]) -> str:
    paragraphs: list[str] = []
    for section in ("question", "answer"):
        rows = rec.get(section)
        if not isinstance(rows, list) or not rows:
            raise Ineligible(f"the fatwa has no {section}")
        texts = [_runs_text(p) for p in rows]
        texts = [t for t in texts if t.strip()]
        if not texts:
            raise Ineligible(f"the fatwa {section} is empty")
        paragraphs.extend(texts)
    body = PARAGRAPH_BREAK.join(paragraphs)
    notes = rec.get("notes") or []
    if not isinstance(notes, list):
        raise Ineligible("malformed notes")
    if notes:
        lines = []
        for note in notes:
            if not isinstance(note, dict) or not isinstance(note.get("id"), (int, str)):
                raise Ineligible("malformed note")
            lines.append(f"[{note['id']}] {_runs_text(note.get('runs'))}")
        body += PARAGRAPH_BREAK + NOTES_HEADING + "\n" + "\n".join(lines)
    return map_honorifics(body)


def hadith_text(rec: dict[str, Any]) -> str:
    text = rec.get("text")
    if not isinstance(text, str) or not text.strip():
        raise Ineligible("the hadith has no text")
    return map_honorifics(text)


def check_bounds(text: str) -> tuple[int, int]:
    from ..lesson_pipeline import MAX_SPAN_CHARS, MAX_SPANS, segment_source

    words = len(text.split())
    if words == 0 or words > MAX_SOURCE_WORDS:
        raise Ineligible(f"the complete unit has {words} words; the limit is {MAX_SOURCE_WORDS} (no excerpts)")
    segments = segment_source(text)
    if not segments or len(segments) > MAX_SPANS or any(len(s.text) > MAX_SPAN_CHARS for s in segments):
        raise Ineligible(f"the complete unit splits into {len(segments)} segments; the bounds are 1-{MAX_SPANS}")
    return words, len(segments)


def adapt(collection: str, rec: dict[str, Any]) -> str:
    if collection in NEVER_ELIGIBLE or collection not in ELIGIBLE:
        raise Ineligible(f"{collection} content is never eligible for lesson generation")
    if rec.get("language") != "ar":
        raise Ineligible("only Arabic records are eligible")
    text = fatwa_text(rec) if collection == "fatwa" else hadith_text(rec)
    check_bounds(text)
    return text


def adapter_id(collection: str, record_id: str) -> str:
    prefix = PUBLISHER_PREFIX[collection]
    if not record_id.startswith(prefix):
        raise Ineligible("unexpected library record id")
    return ID_PREFIX[collection] + record_id[len(prefix):]


def source_version(record_content_sha256: str) -> str:
    return f"{ADAPTER_VERSION}:{record_content_sha256.removeprefix('sha256:')}"


def source_record(unit: dict[str, Any], rec: dict[str, Any], text: str) -> SourceRecord:
    collection = unit["collection"]
    src = rec.get("source") or {}
    hadith = collection == "hadith"
    note = (
        f"Real published {collection} from the integrity-checked local library ({unit['record_id']}), adapted "
        f"deterministically by {ADAPTER_VERSION} with fields {', '.join(unit['included_fields'])}. "
        "Source text is unchanged apart from the documented representation. Not human reviewed."
    )
    return SourceRecord(
        id=unit["id"],
        kind=collection,
        publisher=src.get("publisher_name") or src.get("publisher"),
        title=rec["title"],
        canonical_url=unit["canonical_url"],
        local_reference=None,
        source_version=source_version(unit["record_content_sha256"]),
        retrieved_at=src["retrieved_at"],
        rights_url=None,
        rights_status=str(rec.get("reuse_basis") or "unknown")[:80],
        content_sha256=sha256_text(text),
        language="ar",
        attribution_status="publisher_attribution_required",
        is_test_data=False,
        provenance_note=note,
        collection=None,
        hadith_number=None,
        grading_author=rec.get("grading_authority") if hadith else None,
        fatwa_id=None if hadith else rec.get("source_record_id"),
        library_record_id=unit["record_id"],
        library_collection=collection,
        library_content_sha256=unit["record_content_sha256"],
        adapter_version=ADAPTER_VERSION,
        hadith_attribution=rec.get("attribution") if hadith else None,
        hadith_grade=rec.get("grade") if hadith else None,
        external_check=unit.get("external_check"),
    )


def build_unit(library: Library, collection: str, record_id: str) -> tuple[dict[str, Any], dict[str, Any], str]:
    if collection not in ELIGIBLE:
        raise Ineligible(f"{collection} content is never eligible for lesson generation")
    library.available(collection)
    col = library.records[collection]
    row = col.entries.get(record_id)
    if row is None:
        raise AdapterError(f"{record_id} is not in the {collection} index")
    rec = read_verified(col.base, row["file"], row["sha256"])
    if not isinstance(rec, dict) or rec.get("id") != record_id:
        raise AdapterError(f"{record_id} record does not match its index entry")
    text = adapt(collection, rec)
    words, segments = check_bounds(text)
    unit = {
        "id": adapter_id(collection, record_id),
        "adapter_version": ADAPTER_VERSION,
        "collection": collection,
        "record_id": record_id,
        "file": row["file"],
        "file_sha256": row["sha256"],
        "record_content_sha256": rec.get("content_sha256"),
        "canonical_url": (rec.get("source") or {}).get("url"),
        "included_fields": list(ELIGIBLE[collection]),
        "text_sha256": sha256_text(text),
        "words": words,
        "segments": segments,
    }
    return unit, rec, text


def _load_unit(library: Library, unit: Any, taken: set[str]) -> tuple[SourceRecord, str]:
    if not isinstance(unit, dict):
        raise AdapterError("malformed unit")
    collection = unit.get("collection")
    if collection not in ELIGIBLE:
        raise Ineligible(f"{collection} content is never eligible for lesson generation")
    if unit.get("adapter_version") != ADAPTER_VERSION:
        raise AdapterError("adapter version mismatch")
    if list(unit.get("included_fields") or []) != list(ELIGIBLE[collection]):
        raise AdapterError("included fields do not match the adapter")
    built, rec, text = build_unit(library, collection, str(unit.get("record_id")))
    for key in ("id", "file", "file_sha256", "record_content_sha256", "canonical_url", "text_sha256"):
        if unit.get(key) != built[key]:
            raise AdapterError(f"pinned {key} does not match the verified library record")
    if unit["id"] in taken:
        raise AdapterError(f"adapter id {unit['id']} collides with an existing source")
    return source_record(unit, rec, text), text


def manifest_path(library_root: Path) -> Path:
    return Path(library_root).joinpath(*MANIFEST_REL)


def load_adapters(library_root: Path, existing_ids: frozenset[str], library: Optional[Library] = None) -> AdaptedSet:
    out = AdaptedSet()
    path = manifest_path(library_root)
    if not path.is_file():
        out.errors["manifest"] = "the lesson adapter manifest is missing"
        return out
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        out.errors["manifest"] = f"the lesson adapter manifest cannot be read: {type(e).__name__}"
        return out
    if not isinstance(manifest, dict) or manifest.get("schema") != ADAPTER_SCHEMA:
        out.errors["manifest"] = "the lesson adapter manifest has an unexpected schema"
        return out
    units = manifest.get("units")
    if not isinstance(units, list):
        out.errors["manifest"] = "the lesson adapter manifest has no units list"
        return out
    lib = library if library is not None else Library(Path(library_root))
    taken = set(existing_ids)
    for i, unit in enumerate(units):
        key = unit.get("id") if isinstance(unit, dict) and isinstance(unit.get("id"), str) else f"unit-{i}"
        try:
            rec, text = _load_unit(lib, unit, taken)
        except (AdapterError, SnapshotError, KeyError, TypeError, ValueError) as e:
            out.errors[key] = str(e) or type(e).__name__
            continue
        except Exception as e:
            out.errors[key] = getattr(e, "message", None) or type(e).__name__
            continue
        taken.add(rec.id)
        out.records[rec.id] = rec
        out.texts[rec.id] = text
    return out
