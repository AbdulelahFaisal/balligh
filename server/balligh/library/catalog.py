from __future__ import annotations

import re
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from .snapshot import SnapshotError, bytes_hash, read_json, read_verified, safe_relative, search_key

CATALOG_FILE = "library.json"
CATALOG_SCHEMA = "balligh.library.catalog/1"
COLLECTIONS = ("quran", "fatwa", "hadith")
LOCALES = ("ar", "en", "ur", "zh-Hans", "id", "bn", "fr")
RTL = frozenset({"ar", "ur"})
TOPICS = ("understanding_islam", "belief", "worship", "conduct")
TOPIC_SEARCH_NAMES = {
    "understanding_islam": "understanding islam فهم الإسلام التعريف بالإسلام",
    "belief": "belief faith العقيدة الإيمان",
    "worship": "worship العبادات العبادة",
    "conduct": "conduct manners الأخلاق الآداب المعاملات",
}
MAX_PAGE_SIZE = 50
MAX_QUERY = 80
SURAH_CACHE = 24
PIN = re.compile(r"^sha256:[0-9a-f]{64}$")


class LibraryError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


@dataclass
class Records:
    name: str
    base: Path
    index: dict[str, Any]
    entries: dict[str, dict[str, Any]]
    order: list[str]
    loaded: Optional[dict[str, dict[str, Any]]] = None
    keys: dict[str, str] = field(default_factory=dict)


def _entries(base: Path, index: dict[str, Any], name: str) -> tuple[dict[str, dict[str, Any]], list[str]]:
    rows = index.get("records")
    if not isinstance(rows, list):
        raise SnapshotError(f"{name} index has no records list")
    entries: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str):
            raise SnapshotError(f"{name} index has a malformed record entry")
        if row["id"] in entries:
            raise SnapshotError(f"{name} index repeats id {row['id']}")
        safe_relative(base, row.get("file", ""))
        if not isinstance(row.get("sha256"), str):
            raise SnapshotError(f"{name} index entry {row['id']} has no file hash")
        entries[row["id"]] = row
        order.append(row["id"])
    return entries, order


class Library:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.errors: dict[str, str] = {}
        self.catalog: dict[str, Any] = {}
        self.quran_base = self.root / "quran"
        self.quran: Optional[dict[str, Any]] = None
        self.surah_rows: dict[int, dict[str, Any]] = {}
        self.records: dict[str, Records] = {}
        self._lock = threading.Lock()
        self._surahs: OrderedDict[int, dict[str, Any]] = OrderedDict()
        try:
            pins = self._load_catalog()
        except Exception as e:
            pins = {}
            self.catalog = {}
            for name in COLLECTIONS:
                self.errors[name] = f"the library catalog cannot be read: {type(e).__name__}"
        for name in COLLECTIONS:
            try:
                index = self._load_index(name, pins)
                if name == "quran":
                    self._init_quran(index)
                else:
                    base = self.root / name
                    entries, order = _entries(base, index, name)
                    self.records[name] = Records(name, base, index, entries, order)
            except SnapshotError as e:
                self.errors[name] = str(e)
            except Exception as e:
                self.errors[name] = f"{name} index is malformed: {type(e).__name__}"
            if name in self.errors:
                self.records.pop(name, None)
                if name == "quran":
                    self.quran = None
                    self.surah_rows = {}

    def _fail_all(self, message: str) -> dict[str, str]:
        for name in COLLECTIONS:
            self.errors[name] = message
        return {}

    def _load_catalog(self) -> dict[str, str]:
        if not (self.root / CATALOG_FILE).is_file():
            return self._fail_all("the library catalog is missing")
        try:
            catalog = read_json(self.root, CATALOG_FILE)
        except SnapshotError as e:
            return self._fail_all(str(e))
        if not isinstance(catalog, dict) or catalog.get("schema") != CATALOG_SCHEMA:
            return self._fail_all("the library catalog has an unexpected schema")
        pins = catalog.get("collections")
        if not isinstance(pins, dict):
            return self._fail_all("the library catalog has no collections object")
        unknown = sorted(str(k) for k in pins if k not in COLLECTIONS)
        if unknown:
            return self._fail_all(f"the library catalog pins unknown collections {unknown}")
        snapshot = catalog.get("snapshot")
        if snapshot is not None and not isinstance(snapshot, dict):
            return self._fail_all("the library catalog snapshot is not an object")
        out: dict[str, str] = {}
        for name in COLLECTIONS:
            entry = pins.get(name)
            if not isinstance(entry, dict):
                self.errors[name] = f"{name} is not pinned in the library catalog"
                continue
            pin = entry.get("index_sha256")
            if not isinstance(pin, str) or not PIN.match(pin):
                self.errors[name] = f"{name} has a malformed pin in the library catalog"
                continue
            out[name] = pin
        self.catalog = catalog
        return out

    def _load_index(self, name: str, pins: dict[str, str]) -> dict[str, Any]:
        if name in self.errors:
            raise SnapshotError(self.errors[name])
        expected = pins.get(name)
        if not expected:
            raise SnapshotError(f"{name} is not pinned in the library catalog")
        index = read_verified(self.root / name, "index.json", expected)
        if not isinstance(index, dict):
            raise SnapshotError(f"{name} index is not an object")
        return index

    def _init_quran(self, index: dict[str, Any]) -> None:
        rows = index.get("surahs")
        if not isinstance(rows, list) or not rows:
            raise SnapshotError("quran index has no surahs")
        surahs: dict[int, dict[str, Any]] = {}
        for row in rows:
            number = row.get("number") if isinstance(row, dict) else None
            if not isinstance(number, int) or number in surahs or not 1 <= number <= 114:
                raise SnapshotError("quran index has a malformed surah entry")
            safe_relative(self.quran_base, row.get("file", ""))
            surahs[number] = row
        self.quran = index
        self.surah_rows = surahs

    def available(self, name: str) -> None:
        if name in self.errors:
            raise LibraryError(503, "collection_unavailable", f"The {name} collection is not available: {self.errors[name]}")

    def summary(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.quran is not None:
            out["quran"] = {
                "available": True,
                "range": self.quran.get("range"),
                "locales": {loc: self._quran_locale_count(loc) for loc in LOCALES},
                "tafsir": [t.get("key") for t in self.quran.get("tafsir", [])],
            }
        else:
            out["quran"] = {"available": False, "reason": self.errors.get("quran")}
        for name in ("fatwa", "hadith"):
            if name in self.records:
                try:
                    loaded = self._all(name)
                except SnapshotError as e:
                    out[name] = {"available": False, "reason": str(e)}
                    continue
                locales = {loc: 0 for loc in LOCALES}
                for rec in loaded.values():
                    locales["ar"] += 1
                    for loc in rec.get("translations", {}) or {}:
                        if loc in locales and loc != "ar":
                            locales[loc] += 1
                topics = sorted({rec.get("topic") for rec in loaded.values()} & set(TOPICS), key=TOPICS.index)
                out[name] = {"available": True, "count": len(loaded), "topics": topics, "locales": locales}
            else:
                out[name] = {"available": False, "reason": self.errors.get(name)}
        return {"collections": out, "snapshot": self.catalog.get("snapshot")}

    def _quran_locale_count(self, loc: str) -> int:
        assert self.quran is not None
        total = sum(int(r.get("ayah_count", 0)) for r in self.surah_rows.values())
        if loc == "ar":
            return total
        for ed in self.quran.get("editions", []):
            if ed.get("locale") == loc:
                return int(ed.get("ayah_count", 0))
        return 0

    def quran_overview(self) -> dict[str, Any]:
        self.available("quran")
        assert self.quran is not None
        return {
            "range": self.quran.get("range"),
            "arabic": self.quran.get("arabic"),
            "editions": self.quran.get("editions", []),
            "tafsir": self.quran.get("tafsir", []),
            "notices": self.quran.get("notices", []),
            "quarantine_count": len(self.quran.get("quarantine", [])),
            "surahs": [
                {"number": n, "name_ar": r.get("name_ar"), "ayah_count": r.get("ayah_count")}
                for n, r in sorted(self.surah_rows.items())
            ],
        }

    def _surah(self, number: int) -> dict[str, Any]:
        with self._lock:
            hit = self._surahs.get(number)
            if hit is not None:
                self._surahs.move_to_end(number)
                return hit
        row = self.surah_rows[number]
        data = read_verified(self.quran_base, row["file"], row["sha256"])
        if not isinstance(data, dict) or data.get("number") != number or not isinstance(data.get("ayahs"), list):
            raise SnapshotError(f"surah file {row['file']} does not match its index entry")
        with self._lock:
            self._surahs[number] = data
            while len(self._surahs) > SURAH_CACHE:
                self._surahs.popitem(last=False)
        return data

    def surah(self, number: int, locale: str, tafsir: Optional[str]) -> dict[str, Any]:
        self.available("quran")
        assert self.quran is not None
        if locale not in LOCALES:
            raise LibraryError(422, "bad_locale", "unsupported locale")
        if number not in self.surah_rows:
            raise LibraryError(404, "not_delivered", f"surah {number} is not in the delivered range")
        tafsir_keys = {t.get("key") for t in self.quran.get("tafsir", [])}
        if tafsir is not None and tafsir not in tafsir_keys:
            raise LibraryError(422, "bad_tafsir", "this tafsir layer is not delivered")
        edition = next((e for e in self.quran.get("editions", []) if e.get("locale") == locale), None)
        data = self._surah(number)
        status = "original" if locale == "ar" else ("available" if edition else "unavailable")
        ayahs = []
        for a in data["ayahs"]:
            tr = (a.get("translations") or {}).get(locale) if status == "available" else None
            item: dict[str, Any] = {
                "aya": a.get("aya"),
                "arabic": a.get("arabic"),
                "translation": tr.get("text") if tr else None,
                "footnotes": tr.get("footnotes") if tr else None,
            }
            if tafsir is not None:
                item["tafsir"] = (a.get("tafsir") or {}).get(tafsir)
            ayahs.append(item)
        if status == "available" and any(x["translation"] is None for x in ayahs):
            raise SnapshotError(f"surah {number} is missing {locale} rows")
        numbers = sorted(self.surah_rows)
        pos = numbers.index(number)
        return {
            "number": number,
            "name_ar": data.get("name_ar"),
            "ayah_count": data.get("ayah_count"),
            "locale": locale,
            "dir": "rtl" if locale in RTL else "ltr",
            "translation_status": status,
            "edition": edition if status == "available" else None,
            "tafsir": next((t for t in self.quran.get("tafsir", []) if t.get("key") == tafsir), None),
            "prev": numbers[pos - 1] if pos > 0 else None,
            "next": numbers[pos + 1] if pos + 1 < len(numbers) else None,
            "content_sha256": data.get("content_sha256"),
            "ayahs": ayahs,
        }

    def _all(self, name: str) -> dict[str, dict[str, Any]]:
        col = self.records[name]
        with self._lock:
            if col.loaded is not None:
                return col.loaded
            loaded: dict[str, dict[str, Any]] = {}
            keys: dict[str, str] = {}
            for rid in col.order:
                row = col.entries[rid]
                rec = read_verified(col.base, row["file"], row["sha256"])
                if not isinstance(rec, dict) or rec.get("id") != rid:
                    raise SnapshotError(f"{name} record file {row['file']} does not match its index entry")
                loaded[rid] = rec
                keys[rid] = search_key(" ".join(self._haystack(name, rec)))
            col.loaded = loaded
            col.keys = keys
            return loaded

    def _haystack(self, name: str, rec: dict[str, Any]) -> list[str]:
        parts = [rec.get("title") or "", TOPIC_SEARCH_NAMES.get(rec.get("topic"), ""), rec.get("topic") or ""]
        parts += [c.get("label") or "" for c in rec.get("source_categories", []) if isinstance(c, dict)]
        if name == "hadith":
            parts.append(rec.get("attribution") or "")
        else:
            src = rec.get("source") or {}
            parts += [src.get("series") or "", src.get("edition") or "", rec.get("source_record_id") or ""]
        for tr in (rec.get("translations") or {}).values():
            if isinstance(tr, dict):
                parts += [tr.get("title") or "", tr.get("attribution") or ""]
        return parts

    def _reference(self, name: str, rec: dict[str, Any]) -> str:
        if name == "hadith":
            return rec.get("attribution") or ""
        labels = [c.get("label") for c in rec.get("source_categories", []) if isinstance(c, dict) and c.get("label")]
        return "، ".join(labels)

    def listing(
        self, name: str, *, topic: Optional[str], q: Optional[str], locale: str, page: int, page_size: int
    ) -> dict[str, Any]:
        self.available(name)
        if locale not in LOCALES:
            raise LibraryError(422, "bad_locale", "unsupported locale")
        if topic is not None and topic not in TOPICS:
            raise LibraryError(422, "bad_topic", "unsupported topic")
        if page < 1 or not 1 <= page_size <= MAX_PAGE_SIZE:
            raise LibraryError(422, "bad_page", f"page must be ≥ 1 and page_size 1–{MAX_PAGE_SIZE}")
        if q is not None and len(q) > MAX_QUERY:
            raise LibraryError(422, "bad_query", f"the search text is longer than {MAX_QUERY} characters")
        loaded = self._all(name)
        col = self.records[name]
        tokens = search_key(q or "").split()
        ids = [
            rid
            for rid in col.order
            if (topic is None or loaded[rid].get("topic") == topic) and all(t in col.keys[rid] for t in tokens)
        ]
        start = (page - 1) * page_size
        items = []
        for rid in ids[start : start + page_size]:
            rec = loaded[rid]
            tr = (rec.get("translations") or {}).get(locale) if locale != "ar" else None
            items.append(
                {
                    "id": rid,
                    "title": rec.get("title"),
                    "topic": rec.get("topic"),
                    "reference": self._reference(name, rec),
                    "translated_title": tr.get("title") if isinstance(tr, dict) else None,
                }
            )
        topics = sorted({r.get("topic") for r in loaded.values()} & set(TOPICS), key=TOPICS.index)
        return {"total": len(ids), "page": page, "page_size": page_size, "topics": topics, "items": items}

    def record(self, name: str, rid: str, locale: str) -> dict[str, Any]:
        self.available(name)
        if locale not in LOCALES:
            raise LibraryError(422, "bad_locale", "unsupported locale")
        col = self.records[name]
        if rid not in col.entries:
            raise LibraryError(404, "unknown_record", "unknown library record")
        rec = self._all(name)[rid]
        body = {k: v for k, v in rec.items() if k != "translations"}
        if locale == "ar":
            status, tr = "original", None
        else:
            tr = (rec.get("translations") or {}).get(locale)
            status = "available" if isinstance(tr, dict) else "unavailable"
        return {
            "record": body,
            "locale": locale,
            "dir": "rtl" if locale in RTL else "ltr",
            "translation_status": status,
            "translation": tr if status == "available" else None,
            "available_locales": ["ar"] + [loc for loc in LOCALES if loc in (rec.get("translations") or {})],
        }


def index_pins(root: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for name in COLLECTIONS:
        path = safe_relative(root / name, "index.json")
        out[name] = bytes_hash(path.read_bytes())
    return out
