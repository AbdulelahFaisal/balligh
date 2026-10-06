from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

from .snapshot import SnapshotError, bytes_hash, content_hash, file_bytes, read_json, read_verified, safe_relative

INDEX_SCHEMA = "balligh.library.hadith.index/2"
RECORD_SCHEMA = "balligh.library.hadith/2"
PUBLISHER = "HadeethEnc.com"
API_BASE = "https://hadeethenc.com/api/v1"
REQUIRED_GRADE = "صحيح"
GRADING_AUTHORITY = "HadeethEnc.com (grade field of the published record)"
REUSE_BASIS = "hadeethenc_terms"
REVIEW_STATUS = "source_preserved"
TOPICS = ("understanding_islam", "belief", "worship", "conduct")
LOCALES = ("ar", "en", "ur", "zh-Hans", "id", "bn", "fr")
SOURCE_CODES = {"en": "en", "ur": "ur", "zh-Hans": "zh", "id": "id", "bn": "bn", "fr": "fr"}
MIN_COUNT = 100
MAX_COUNT = 200
DIGITS = re.compile(r"^[1-9][0-9]{0,9}$")
RECORD_ID = re.compile(r"^hadeethenc-([1-9][0-9]{0,9})$")
TRANSLATION_KEYS = ("title", "text", "attribution", "grade", "explanation", "hints", "words_meanings",
                    "words_meanings_language", "source_url", "api_url", "retrieved_at", "source_language_code",
                    "arabic_match", "mapping", "content_sha256")
NARRATION_MISMATCH = "hadeeth_ar differs from the selected Arabic narration"
ARABIC_MATCHES = ("exact", "not_provided")


class ShapeError(ValueError):
    pass


class NarrationMismatch(ShapeError):
    pass


def mapping_text(record_id: str, arabic_match: str) -> str:
    if arabic_match == "exact":
        return (f"same HadeethEnc record id {record_id}; the response's hadeeth_ar equals the Arabic record text "
                "byte-for-byte")
    return (f"same HadeethEnc record id {record_id}; the response carries no hadeeth_ar, so its Arabic narration "
            "was not compared")


def _word_notes(value: Any, name: str) -> list[dict[str, str]]:
    if value is None:
        return []
    if not isinstance(value, list) or any(
        not isinstance(n, dict) or set(n) != {"word", "meaning"} or not isinstance(n["word"], str)
        or not isinstance(n["meaning"], str) for n in value
    ):
        raise ShapeError(f"{name} is not a list of {{word, meaning}} strings")
    return [dict(n) for n in value]


def _blank(value: Any) -> bool:
    return not isinstance(value, str) or not value.strip()


def _int_like(value: Any) -> int:
    if isinstance(value, bool):
        raise ShapeError("meta value is not a number")
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    raise ShapeError("meta value is not a number")


def _string_list(value: Any, name: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(v, str) for v in value):
        raise ShapeError(f"{name} is not a list of strings")
    return value


def list_url(category_id: str, page: int, per_page: int) -> str:
    return f"{API_BASE}/hadeeths/list/?language=ar&category_id={category_id}&page={page}&per_page={per_page}"


def detail_url(code: str, record_id: str) -> str:
    return f"{API_BASE}/hadeeths/one/?language={code}&id={record_id}"


def browse_url(code: str, record_id: str) -> str:
    return f"https://hadeethenc.com/{code}/browse/hadith/{record_id}"


def check_categories(payload: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(payload, list) or not payload:
        raise ShapeError("category list is not a non-empty list")
    out: dict[str, dict[str, Any]] = {}
    for item in payload:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not DIGITS.match(item["id"]):
            raise ShapeError("category without a numeric id")
        if _blank(item.get("title")):
            raise ShapeError(f"category {item['id']} has no title")
        parent = item.get("parent_id")
        if parent is not None and (not isinstance(parent, str) or not DIGITS.match(parent)):
            raise ShapeError(f"category {item['id']} has a malformed parent_id")
        out[item["id"]] = {"id": item["id"], "title": item["title"], "parent_id": parent}
    return out


def check_list(payload: Any) -> tuple[list[dict[str, Any]], dict[str, int]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list) or not isinstance(payload.get("meta"), dict):
        raise ShapeError("list response is not {data: [...], meta: {...}}")
    meta = payload["meta"]
    try:
        info = {k: _int_like(meta.get(k)) for k in ("current_page", "last_page", "total_items", "per_page")}
    except ShapeError:
        raise ShapeError("list meta is malformed") from None
    items = []
    for item in payload["data"]:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not DIGITS.match(item["id"]):
            raise ShapeError("list item without a numeric id")
        if _blank(item.get("title")):
            raise ShapeError(f"list item {item['id']} has no title")
        items.append({"id": item["id"], "title": item["title"], "translations": _string_list(item.get("translations"), "translations")})
    return items, info


def check_detail(payload: Any, expected_id: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ShapeError("detail response is not an object")
    if payload.get("id") != expected_id:
        raise ShapeError(f"detail id {payload.get('id')!r} does not match requested id {expected_id}")
    for key in ("title", "hadeeth", "attribution", "explanation"):
        if _blank(payload.get(key)):
            raise ShapeError(f"detail field {key!r} is missing or blank")
    grade = payload.get("grade")
    if grade is not None and not isinstance(grade, str):
        raise ShapeError("detail grade is not a string")
    _string_list(payload.get("hints"), "hints")
    _string_list(payload.get("categories"), "categories")
    _string_list(payload.get("translations"), "translations")
    reference = payload.get("reference")
    if reference is not None and not isinstance(reference, str):
        raise ShapeError("detail reference is not a string")
    _word_notes(payload.get("words_meanings"), "detail words_meanings")
    return payload


def admission(detail: Mapping[str, Any]) -> Optional[str]:
    grade = detail.get("grade")
    if grade is None:
        return "grade field missing"
    if grade == REQUIRED_GRADE:
        return None
    if not grade.strip():
        return "grade field blank"
    return f"grade {grade!r} is not exactly {REQUIRED_GRADE!r}"


def check_translation(payload: Any, record_id: str, arabic: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ShapeError("translation response is not an object")
    if payload.get("id") != record_id:
        raise ShapeError(f"translation id {payload.get('id')!r} does not match HadeethEnc record id {record_id}")
    for key in ("title", "hadeeth", "attribution", "grade", "explanation"):
        if _blank(payload.get(key)):
            raise ShapeError(f"translation field {key!r} is missing or blank")
    _string_list(payload.get("hints"), "hints")
    grade_ar = payload.get("grade_ar")
    if grade_ar is not None and grade_ar != arabic["grade"]:
        raise ShapeError(f"translation grade_ar {grade_ar!r} differs from the Arabic grade")
    hadeeth_ar = payload.get("hadeeth_ar")
    if hadeeth_ar is not None:
        if not isinstance(hadeeth_ar, str):
            raise ShapeError("translation hadeeth_ar is not a string")
        if hadeeth_ar.encode("utf-8") != arabic["hadeeth"].encode("utf-8"):
            raise NarrationMismatch(NARRATION_MISMATCH)
    _word_notes(payload.get("words_meanings"), "translation words_meanings")
    _word_notes(payload.get("words_meanings_ar"), "translation words_meanings_ar")
    return payload


def arabic_match(payload: Mapping[str, Any]) -> str:
    return "not_provided" if payload.get("hadeeth_ar") is None else "exact"


def localized_notes(payload: Mapping[str, Any], arabic: Mapping[str, Any]) -> list[dict[str, str]]:
    notes = _word_notes(payload.get("words_meanings"), "translation words_meanings")
    copies = (_word_notes(payload.get("words_meanings_ar"), "translation words_meanings_ar"),
              _word_notes(arabic.get("words_meanings"), "detail words_meanings"))
    if not notes or any(notes == c for c in copies):
        return []
    return notes


def translation_hash(entry: Mapping[str, Any]) -> str:
    return content_hash({k: v for k, v in entry.items() if k != "content_sha256"})


def record_hash(record: Mapping[str, Any]) -> str:
    return content_hash({k: v for k, v in record.items() if k != "content_sha256"})


def build_translation(locale: str, payload: Mapping[str, Any], retrieved_at: str,
                      arabic: Mapping[str, Any]) -> dict[str, Any]:
    code = SOURCE_CODES[locale]
    record_id = payload["id"]
    match = arabic_match(payload)
    notes = localized_notes(payload, arabic)
    entry = {
        "title": payload["title"],
        "text": payload["hadeeth"],
        "attribution": payload["attribution"],
        "grade": payload["grade"],
        "explanation": payload["explanation"],
        "hints": list(payload["hints"]),
        "words_meanings": notes,
        "words_meanings_language": code if notes else None,
        "source_url": browse_url(code, record_id),
        "api_url": detail_url(code, record_id),
        "retrieved_at": retrieved_at,
        "source_language_code": code,
        "arabic_match": match,
        "mapping": mapping_text(record_id, match),
    }
    entry["content_sha256"] = translation_hash(entry)
    return entry


def build_record(
    detail: Mapping[str, Any],
    retrieved_at: str,
    topic: str,
    labels: Mapping[str, str],
    dorar: Mapping[str, str],
    translations: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    if topic not in TOPICS:
        raise ValueError(f"unknown topic {topic!r}")
    record_id = detail["id"]
    record = {
        "schema": RECORD_SCHEMA,
        "id": f"hadeethenc-{record_id}",
        "source_record_id": record_id,
        "type": "hadith",
        "language": "ar",
        "title": detail["title"],
        "text": detail["hadeeth"],
        "attribution": detail["attribution"],
        "grade": detail["grade"],
        "grading_authority": GRADING_AUTHORITY,
        "narrator": None,
        "reference": detail.get("reference"),
        "explanation": detail["explanation"],
        "hints": list(detail["hints"]),
        "words_meanings": _word_notes(detail.get("words_meanings"), "detail words_meanings"),
        "words_meanings_language": "ar",
        "topic": topic,
        "source_categories": [{"id": c, "label": labels.get(c)} for c in detail["categories"]],
        "source": {
            "publisher": PUBLISHER,
            "url": browse_url("ar", record_id),
            "api_url": detail_url("ar", record_id),
            "retrieved_at": retrieved_at,
        },
        "dorar": {"status": dorar["status"], "reason": dorar["reason"]},
        "reuse_basis": REUSE_BASIS,
        "review_status": REVIEW_STATUS,
        "translations": {loc: dict(translations[loc]) for loc in LOCALES[1:] if loc in translations},
    }
    record["content_sha256"] = record_hash(record)
    return record


def record_locales(record: Mapping[str, Any]) -> list[str]:
    return ["ar"] + [loc for loc in LOCALES[1:] if loc in record["translations"]]


def build_files(
    records: Iterable[Mapping[str, Any]],
    exclusions: Iterable[Mapping[str, Any]],
    selection: Mapping[str, Any],
    notices: Iterable[str],
) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    entries = []
    for record in sorted(records, key=lambda r: int(r["source_record_id"])):
        rel = f"records/{record['id']}.json"
        if rel in files:
            raise SnapshotError(f"duplicate record id {record['id']}")
        data = file_bytes(record)
        files[rel] = data
        entries.append({
            "id": record["id"],
            "title": record["title"],
            "topic": record["topic"],
            "attribution": record["attribution"],
            "grade": record["grade"],
            "locales": record_locales(record),
            "file": rel,
            "sha256": bytes_hash(data),
            "content_sha256": record["content_sha256"],
        })
    index = {
        "schema": INDEX_SCHEMA,
        "count": len(entries),
        "incomplete": False,
        "records": entries,
        "exclusions": [dict(e) for e in exclusions],
        "selection": dict(selection),
        "notices": list(notices),
    }
    files["index.json"] = file_bytes(index)
    return files


def _fail(message: str) -> None:
    raise SnapshotError(message)


def _check_translation_entry(locale: str, entry: Any, record_id: str) -> None:
    if locale not in SOURCE_CODES:
        _fail(f"hadeethenc-{record_id}: translation locale {locale!r} is not allowed")
    if not isinstance(entry, dict) or set(entry) != set(TRANSLATION_KEYS):
        _fail(f"hadeethenc-{record_id}: translation {locale} has unexpected fields")
    for key in ("title", "text", "attribution", "grade", "explanation", "retrieved_at"):
        if _blank(entry.get(key)):
            _fail(f"hadeethenc-{record_id}: translation {locale} field {key} is blank")
    if not isinstance(entry["hints"], list) or any(not isinstance(h, str) for h in entry["hints"]):
        _fail(f"hadeethenc-{record_id}: translation {locale} hints are malformed")
    code = SOURCE_CODES[locale]
    if entry["source_language_code"] != code:
        _fail(f"hadeethenc-{record_id}: translation {locale} source_language_code mismatch")
    try:
        notes = _word_notes(entry["words_meanings"], "words_meanings")
    except ShapeError:
        notes = None
    if notes is None or entry["words_meanings"] is None or \
            entry["words_meanings_language"] != (code if notes else None):
        _fail(f"hadeethenc-{record_id}: translation {locale} word notes are malformed")
    if entry["arabic_match"] not in ARABIC_MATCHES:
        _fail(f"hadeethenc-{record_id}: translation {locale} arabic_match is not one of {ARABIC_MATCHES}")
    if entry["mapping"] != mapping_text(record_id, entry["arabic_match"]):
        _fail(f"hadeethenc-{record_id}: translation {locale} maps to a different record")
    if entry["source_url"] != browse_url(code, record_id) or entry["api_url"] != detail_url(code, record_id):
        _fail(f"hadeethenc-{record_id}: translation {locale} urls do not match the record id")
    if entry["content_sha256"] != translation_hash(entry):
        _fail(f"hadeethenc-{record_id}: translation {locale} content hash mismatch")


def _check_record(record: Any, entry: Mapping[str, Any]) -> None:
    if not isinstance(record, dict) or record.get("schema") != RECORD_SCHEMA:
        _fail(f"{entry['id']}: record schema mismatch")
    if record.get("id") != entry["id"]:
        _fail(f"{entry['id']}: record id does not match the index")
    record_id = RECORD_ID.match(entry["id"]).group(1)
    if record.get("source_record_id") != record_id or record.get("type") != "hadith" or record.get("language") != "ar":
        _fail(f"{entry['id']}: record identity fields are wrong")
    for key in ("title", "text", "attribution", "grade", "grading_authority", "explanation"):
        if _blank(record.get(key)):
            _fail(f"{entry['id']}: field {key} is blank")
    if record["grade"] != REQUIRED_GRADE:
        _fail(f"{entry['id']}: grade {record['grade']!r} is not {REQUIRED_GRADE!r}")
    if record["grading_authority"] != GRADING_AUTHORITY:
        _fail(f"{entry['id']}: grading_authority mismatch")
    if record.get("narrator") is not None:
        _fail(f"{entry['id']}: narrator must be null")
    if record.get("reference") is not None and not isinstance(record["reference"], str):
        _fail(f"{entry['id']}: reference is malformed")
    if not isinstance(record.get("hints"), list) or any(not isinstance(h, str) for h in record["hints"]):
        _fail(f"{entry['id']}: hints are malformed")
    try:
        _word_notes(record.get("words_meanings", 0), "words_meanings")
    except ShapeError:
        _fail(f"{entry['id']}: words_meanings are malformed")
    if record.get("words_meanings") is None or record.get("words_meanings_language") != "ar":
        _fail(f"{entry['id']}: words_meanings are malformed")
    if record.get("topic") not in TOPICS:
        _fail(f"{entry['id']}: unknown topic")
    cats = record.get("source_categories")
    if not isinstance(cats, list) or any(
        not isinstance(c, dict) or set(c) != {"id", "label"} or not isinstance(c["id"], str)
        or not (c["label"] is None or isinstance(c["label"], str)) for c in cats
    ):
        _fail(f"{entry['id']}: source_categories are malformed")
    source = record.get("source")
    if not isinstance(source, dict) or source.get("publisher") != PUBLISHER or source.get("url") != browse_url("ar", record_id) \
            or source.get("api_url") != detail_url("ar", record_id) or _blank(source.get("retrieved_at")):
        _fail(f"{entry['id']}: source block is wrong")
    dorar = record.get("dorar")
    if not isinstance(dorar, dict) or dorar.get("status") != "not_verified" or _blank(dorar.get("reason")):
        _fail(f"{entry['id']}: dorar status is missing")
    if record.get("reuse_basis") != REUSE_BASIS or record.get("review_status") != REVIEW_STATUS:
        _fail(f"{entry['id']}: reuse_basis or review_status is wrong")
    translations = record.get("translations")
    if not isinstance(translations, dict):
        _fail(f"{entry['id']}: translations are malformed")
    for locale, tr in translations.items():
        _check_translation_entry(locale, tr, record_id)
    if record.get("content_sha256") != record_hash(record):
        _fail(f"{entry['id']}: content hash mismatch")
    for key in ("title", "topic", "attribution", "grade", "content_sha256"):
        if entry.get(key) != record.get(key):
            _fail(f"{entry['id']}: index field {key} does not match the record")
    if entry.get("locales") != record_locales(record):
        _fail(f"{entry['id']}: index locales do not match the record")


def validate_hadith_dir(path: Path, minimum: int = MIN_COUNT, maximum: int = MAX_COUNT) -> dict[str, Any]:
    base = Path(path)
    index = read_json(base, "index.json")
    if not isinstance(index, dict) or index.get("schema") != INDEX_SCHEMA:
        _fail("index schema mismatch")
    entries = index.get("records")
    if not isinstance(entries, list) or index.get("count") != len(entries):
        _fail("index count does not match its records")
    if minimum < MIN_COUNT or maximum > MAX_COUNT or minimum > maximum:
        _fail(f"collection limits must stay within {MIN_COUNT}..{MAX_COUNT}")
    incomplete = index.get("incomplete")
    if incomplete is not False:
        _fail("index must be a complete collection (incomplete is not false)")
    count = len(entries)
    if count > maximum:
        _fail(f"record count {count} is outside {minimum}..{maximum}")
    if count < minimum:
        _fail(f"record count {count} is below the minimum {minimum}")
    seen: set[str] = set()
    expected_files = {"index.json"}
    locales = {loc: 0 for loc in LOCALES}
    topics = {t: 0 for t in TOPICS}
    full = 0
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not RECORD_ID.match(entry["id"]):
            _fail("index entry without a valid id")
        if entry["id"] in seen:
            _fail(f"duplicate record id {entry['id']}")
        seen.add(entry["id"])
        rel = entry.get("file")
        if not isinstance(rel, str):
            _fail(f"{entry['id']}: file is missing")
        safe_relative(base, rel)
        if rel != f"records/{entry['id']}.json":
            _fail(f"{entry['id']}: unexpected file path {rel!r}")
        if not isinstance(entry.get("sha256"), str):
            _fail(f"{entry['id']}: file hash missing")
        record = read_verified(base, rel, entry["sha256"])
        _check_record(record, entry)
        expected_files.add(rel)
        for loc in entry["locales"]:
            locales[loc] += 1
        if len(entry["locales"]) == len(LOCALES):
            full += 1
        topics[record["topic"]] += 1
    exclusions = index.get("exclusions")
    if not isinstance(exclusions, list) or any(
        not isinstance(e, dict) or not isinstance(e.get("source_record_id"), str) or _blank(e.get("reason")) for e in exclusions
    ):
        _fail("exclusions are malformed")
    if {f"hadeethenc-{e['source_record_id']}" for e in exclusions} & seen:
        _fail("a record is both admitted and excluded")
    if not isinstance(index.get("selection"), dict) or not isinstance(index.get("notices"), list):
        _fail("selection or notices missing")
    resolved = base.resolve()
    for root, _dirs, names in os.walk(resolved):
        for name in names:
            rel = Path(root, name).relative_to(resolved).as_posix()
            if rel not in expected_files:
                _fail(f"unexpected file {rel!r} in the snapshot")
    return {
        "count": count,
        "incomplete": incomplete,
        "locales": locales,
        "full_locale_records": full,
        "topics": topics,
        "exclusions": len(exclusions),
    }
