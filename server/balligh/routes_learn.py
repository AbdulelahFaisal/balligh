from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, FastAPI, HTTPException, Request

from .library.catalog import LOCALES, Library, LibraryError
from .library.snapshot import SnapshotError

SCHEMA = "balligh.learn.v1"
VERSION = "2026-10-06.1"
MAX_BYTES = 256 * 1024
MAX_TEXT = 600
TOP_KEYS = frozenset({"schema", "version", "basis", "first_steps", "teacher_context"})
STEP_KEYS = frozenset({"order", "collection", "source_id", "level", "topic", "languages", "caution", "reason"})
TEACHER_KEYS = frozenset({"collection", "source_id", "classification", "reason"})
COLLECTIONS = ("quran", "fatwa", "hadith")
LEVELS = frozenset({"foundation", "practical_beginner"})
TOPICS = frozenset(
    {
        "opening_prayer",
        "what_islam_means",
        "testimonies",
        "oneness",
        "pillars",
        "wudu_steps",
        "missed_prayer_sleep",
        "obligations_first",
        "good_conduct",
        "names_after_islam",
    }
)
CAUTIONS = frozenset({"obligation_vs_preference"})
CLASSIFICATIONS = frozenset({"teacher_context", "advanced_reference", "adult_situational_reference", "family_specific"})
EXCLUDED = frozenset(
    f"binbaz-{n}" for n in (1157, 1263, 1998, 2171, 2554, 5629, 11643, 1655, 2089, 2460, 2994, 1524)
)
HREF = {"quran": "/library/quran/{}", "fatwa": "/library/questions/{}", "hadith": "/library/hadith/{}"}
SURAH_ID = re.compile(r"^[1-9][0-9]{0,2}$")
RECORD_ID = re.compile(r"^[a-z]+-[0-9]{1,9}$")


class ManifestError(Exception):
    pass


def manifest_path(library: Library) -> Path:
    return library.root.parent / "learn" / "learn.json"


def _text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_TEXT:
        raise ManifestError(f"{field} must be a non-empty string of at most {MAX_TEXT} characters")
    return value


def _lookup(library: Library, collection: str, source_id: str) -> tuple[str, list[str]]:
    if not isinstance(source_id, str):
        raise ManifestError("source_id must be a string")
    if collection == "quran":
        library.available("quran")
        if not SURAH_ID.match(source_id) or int(source_id) not in library.surah_rows:
            raise ManifestError(f"surah {source_id!r} is not in the delivered Quran range")
        editions = (library.quran or {}).get("editions", [])
        locales = ["ar"] + [loc for loc in LOCALES if any(e.get("locale") == loc for e in editions)]
        title = library.surah_rows[int(source_id)].get("name_ar")
    else:
        if not RECORD_ID.match(source_id):
            raise ManifestError(f"{collection} id {source_id!r} is malformed")
        try:
            found = library.record(collection, source_id, "ar")
        except LibraryError as e:
            if e.status == 404:
                raise ManifestError(f"{collection} id {source_id} is not in the library index") from None
            raise
        locales = list(found.get("available_locales") or ["ar"])
        title = found["record"].get("title")
    if not isinstance(title, str) or not title:
        raise ManifestError(f"{collection} {source_id} has no title")
    return title, locales


def _languages(value: Any, collection: str, available: list[str], where: str) -> list[str]:
    if not isinstance(value, list) or not value or not all(isinstance(x, str) for x in value):
        raise ManifestError(f"{where}: languages must be a non-empty list of locale codes")
    if value[0] != "ar" or len(set(value)) != len(value):
        raise ManifestError(f"{where}: languages must start with ar and be unique")
    unknown = [x for x in value if x not in LOCALES]
    if unknown:
        raise ManifestError(f"{where}: unsupported locales {unknown}")
    if collection == "fatwa" and value != ["ar"]:
        raise ManifestError(f"{where}: fatwas are Arabic-only published records")
    missing = [x for x in value if x not in available]
    if missing:
        raise ManifestError(f"{where}: no published content in {missing}")
    return value


def validate_manifest(data: Any, library: Library) -> dict[str, Any]:
    if not isinstance(data, dict) or set(data) != TOP_KEYS:
        raise ManifestError("the manifest has unexpected top-level fields")
    if data["schema"] != SCHEMA or data["version"] != VERSION:
        raise ManifestError("the manifest schema or version is not supported")
    basis = _text(data["basis"], "basis")
    steps, teacher = data["first_steps"], data["teacher_context"]
    if not isinstance(steps, list) or not steps or not isinstance(teacher, list):
        raise ManifestError("first_steps must be a non-empty list and teacher_context a list")
    seen: set[tuple[str, str]] = set()
    out_steps: list[dict[str, Any]] = []
    for i, step in enumerate(steps, start=1):
        where = f"first step {i}"
        if not isinstance(step, dict) or set(step) != STEP_KEYS:
            raise ManifestError(f"{where} has unexpected fields")
        order, collection, source_id = step["order"], step["collection"], step["source_id"]
        if type(order) is not int or order != i:
            raise ManifestError(f"{where}: order must be {i}")
        if collection not in COLLECTIONS:
            raise ManifestError(f"{where}: unknown collection")
        if (collection, source_id) in seen:
            raise ManifestError(f"{where}: {source_id} is repeated")
        if collection == "fatwa" and source_id in EXCLUDED:
            raise ManifestError(f"{where}: {source_id} is excluded from the default sequence")
        if step["level"] not in LEVELS or step["topic"] not in TOPICS:
            raise ManifestError(f"{where}: unknown level or topic")
        caution: Optional[str] = step["caution"]
        if caution is not None and caution not in CAUTIONS:
            raise ManifestError(f"{where}: unknown caution")
        _text(step["reason"], f"{where} reason")
        title, available = _lookup(library, collection, source_id)
        languages = _languages(step["languages"], collection, available, where)
        seen.add((collection, source_id))
        out_steps.append({**step, "languages": languages, "title": title, "href": HREF[collection].format(source_id)})
    marked: set[tuple[str, str]] = set()
    out_teacher: list[dict[str, Any]] = []
    for j, item in enumerate(teacher, start=1):
        where = f"teacher context {j}"
        if not isinstance(item, dict) or set(item) != TEACHER_KEYS:
            raise ManifestError(f"{where} has unexpected fields")
        collection, source_id = item["collection"], item["source_id"]
        if collection not in ("fatwa", "hadith"):
            raise ManifestError(f"{where}: unsupported collection")
        if item["classification"] not in CLASSIFICATIONS:
            raise ManifestError(f"{where}: unknown classification")
        _text(item["reason"], f"{where} reason")
        if (collection, source_id) in marked:
            raise ManifestError(f"{where}: {source_id} is repeated")
        if (collection, source_id) in seen:
            raise ManifestError(f"{where}: {source_id} is also in the default sequence")
        title, _ = _lookup(library, collection, source_id)
        marked.add((collection, source_id))
        out_teacher.append({**item, "title": title, "href": HREF[collection].format(source_id)})
    return {"schema": SCHEMA, "version": VERSION, "basis": basis, "first_steps": out_steps, "teacher_context": out_teacher}


def load_manifest(path: Path, library: Library) -> dict[str, Any]:
    try:
        raw = path.read_bytes()
    except OSError as e:
        raise ManifestError(f"the manifest cannot be read: {type(e).__name__}") from None
    if len(raw) > MAX_BYTES:
        raise ManifestError("the manifest is too large")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ManifestError("the manifest is not valid JSON") from None
    return validate_manifest(data, library)


STAGES_SCHEMA = "balligh.learn.stages.v1"
STAGES_VERSION = "2026-10-06.1"
STAGES_TOP = frozenset({"schema", "version", "path_id", "stages", "not_covered", "human_support"})
STAGE_KEYS = frozenset({"order", "key", "entries"})
ENTRY_KEYS = frozenset({"collection", "source_id", "recap"})
STAGE_NAMES = ("introduction_belief", "testimony_pillars", "purification_prayer", "fasting_zakah_hajj", "everyday_conduct")
NOT_COVERED = ("prayer_demonstration", "fasting_rules", "zakah_calculation", "hajj_practice")
SUPPORT = {
    "name": "eDialogue",
    "operator_ar": "جمعية ركن الحوار",
    "url": "https://edialogue.org/",
    "faq_url": "https://edialogue.org/faq/",
}
NOT_BEGINNER = EXCLUDED | frozenset(
    f"binbaz-{n}" for n in (15, 1614, 2002, 2348, 2631, 2778, 3442, 3446, 3709, 5627, 6782, 9614)
)
PATH_ID = re.compile(r"^[a-z][a-z0-9-]{0,63}$")


def stages_path(library: Library) -> Path:
    return library.root.parent / "learn" / "stages.json"


def _content_sha(library: Library, collection: str, source_id: str) -> str:
    if collection == "quran":
        value = library.surah_rows[int(source_id)].get("sha256")
    else:
        value = library.record(collection, source_id, "ar")["record"].get("content_sha256")
    if not isinstance(value, str) or not re.match(r"^(sha256:)?[0-9a-f]{64}$", value):
        raise ManifestError(f"{collection} {source_id} has no content identity")
    return value.removeprefix("sha256:")


def validate_stages(data: Any, library: Library) -> dict[str, Any]:
    if not isinstance(data, dict) or set(data) != STAGES_TOP:
        raise ManifestError("the stage path has unexpected top-level fields")
    if data["schema"] != STAGES_SCHEMA or data["version"] != STAGES_VERSION:
        raise ManifestError("the stage path schema or version is not supported")
    if not isinstance(data["path_id"], str) or not PATH_ID.match(data["path_id"]):
        raise ManifestError("the stage path id is malformed")
    if data["not_covered"] != list(NOT_COVERED):
        raise ManifestError("the stage path must state exactly what it does not cover")
    if data["human_support"] != SUPPORT:
        raise ManifestError("the human-support destination is not the reviewed eDialogue link")
    stages = data["stages"]
    if not isinstance(stages, list) or len(stages) != len(STAGE_NAMES):
        raise ManifestError(f"the stage path must have {len(STAGE_NAMES)} stages")
    seen: set[tuple[str, str]] = set()
    out_stages: list[dict[str, Any]] = []
    identity: list[str] = []
    total = 0
    for n, stage in enumerate(stages, start=1):
        where = f"stage {n}"
        if not isinstance(stage, dict) or set(stage) != STAGE_KEYS:
            raise ManifestError(f"{where} has unexpected fields")
        if type(stage["order"]) is not int or stage["order"] != n or stage["key"] != STAGE_NAMES[n - 1]:
            raise ManifestError(f"{where}: order or key is out of sequence")
        entries = stage["entries"]
        if not isinstance(entries, list) or not entries:
            raise ManifestError(f"{where} has no entries")
        out_entries: list[dict[str, Any]] = []
        for k, entry in enumerate(entries, start=1):
            at = f"{where} entry {k}"
            if not isinstance(entry, dict) or set(entry) != ENTRY_KEYS:
                raise ManifestError(f"{at} has unexpected fields")
            collection, source_id, recap = entry["collection"], entry["source_id"], entry["recap"]
            if collection not in COLLECTIONS or type(recap) is not bool:
                raise ManifestError(f"{at}: unknown collection or recap flag")
            if collection == "fatwa" and source_id in NOT_BEGINNER:
                raise ManifestError(f"{at}: {source_id} is not a beginner recommendation")
            pair = (collection, source_id)
            if recap and pair not in seen:
                raise ManifestError(f"{at}: a recap must repeat an earlier entry")
            if not recap and pair in seen:
                raise ManifestError(f"{at}: {source_id} is repeated without being marked as a recap")
            title, languages = _lookup(library, collection, source_id)
            if collection == "fatwa":
                languages = ["ar"]
            sha = _content_sha(library, collection, source_id)
            seen.add(pair)
            total += 1
            identity.append(f"{n}:{collection}/{source_id}:{int(recap)}:{sha}")
            out_entries.append(
                {
                    "collection": collection,
                    "source_id": source_id,
                    "recap": recap,
                    "title": title,
                    "languages": languages,
                    "content_sha256": sha,
                    "href": HREF[collection].format(source_id),
                }
            )
        out_stages.append({"order": n, "key": stage["key"], "entries": out_entries})
    digest = hashlib.sha256("\n".join(identity).encode("utf-8")).hexdigest()
    return {
        "schema": STAGES_SCHEMA,
        "version": STAGES_VERSION,
        "path_id": data["path_id"],
        "identity": digest,
        "entry_count": total,
        "distinct_count": len(seen),
        "stages": out_stages,
        "not_covered": list(NOT_COVERED),
        "human_support": dict(SUPPORT),
    }


def load_stages(path: Path, library: Library) -> dict[str, Any]:
    try:
        raw = path.read_bytes()
    except OSError as e:
        raise ManifestError(f"the stage path cannot be read: {type(e).__name__}") from None
    if len(raw) > MAX_BYTES:
        raise ManifestError("the stage path is too large")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ManifestError("the stage path is not valid JSON") from None
    return validate_stages(data, library)


router = APIRouter(prefix="/api")


@router.get("/learn/stages")
def learn_stages(request: Request) -> dict[str, Any]:
    library = getattr(request.app.state, "library", None)
    try:
        if not isinstance(library, Library):
            raise ManifestError("the library is not loaded")
        path = getattr(request.app.state, "learn_stages", None) or stages_path(library)
        return load_stages(Path(path), library)
    except (ManifestError, LibraryError, SnapshotError, KeyError, TypeError, ValueError) as e:
        message = e.message if isinstance(e, LibraryError) else str(e) if isinstance(e, ManifestError) else type(e).__name__
        raise HTTPException(
            503, {"code": "learn_stages_unavailable", "message": f"The stage path is not available: {message}"}
        ) from None


@router.get("/learn")
def learn(request: Request) -> dict[str, Any]:
    library = getattr(request.app.state, "library", None)
    try:
        if not isinstance(library, Library):
            raise ManifestError("the library is not loaded")
        path = getattr(request.app.state, "learn_manifest", None) or manifest_path(library)
        return load_manifest(Path(path), library)
    except (ManifestError, LibraryError, SnapshotError, KeyError, TypeError, ValueError) as e:
        message = e.message if isinstance(e, LibraryError) else str(e) if isinstance(e, ManifestError) else type(e).__name__
        raise HTTPException(
            503, {"code": "learn_unavailable", "message": f"The first-step manifest is not available: {message}"}
        ) from None


def is_learn_route(route: Any) -> bool:
    return getattr(route, "path", None) == "/api/learn" or getattr(route, "original_router", None) is router


def install(app: FastAPI) -> FastAPI:
    if any(is_learn_route(r) for r in app.router.routes):
        return app
    before = len(app.router.routes)
    app.include_router(router)
    added = app.router.routes[before:]
    del app.router.routes[before:]
    app.router.routes[0:0] = added
    return app
