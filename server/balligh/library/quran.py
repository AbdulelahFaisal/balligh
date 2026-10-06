from __future__ import annotations

import html
import json
import re
from itertools import accumulate
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

from .snapshot import SnapshotError, bytes_hash, content_hash, file_bytes, read_json, read_verified

INDEX_SCHEMA = "balligh.library.quran.index/1"
SURAH_SCHEMA = "balligh.library.quran.surah/1"
API_BASE = "https://quranenc.com/api/v1"
LIST_URL = API_BASE + "/translations/list"
SURA_URL = API_BASE + "/translation/sura/{key}/{surah}"
BROWSE_URL = "https://quranenc.com/en/browse/{key}"
CATALOG_URL = "https://quranenc.com/en/home"
CATALOG_AR_URL = "https://quranenc.com/ar"
TERMS_URL = "https://quranenc.com/en/home/api/"
NAMES_URL = "https://quranenc.com/ar/browse/arabic_moyassar"

EDITIONS = (
    ("english_rwwad", "en"),
    ("urdu_junagarhi", "ur"),
    ("chinese_suliman", "zh-Hans"),
    ("indonesian_affairs", "id"),
    ("bengali_rwwad", "bn"),
    ("french_rashid", "fr"),
)
EDITION_KEYS = tuple(key for key, _ in EDITIONS)
LOCALES = tuple(locale for _, locale in EDITIONS)
SOURCE_LANGUAGE = {"en": "en", "ur": "ur", "zh-Hans": "zh", "id": "id", "bn": "bn", "fr": "fr"}
TAFSIR_KEY = "arabic_moyassar"
TAFSIR_LABEL = "Al-Tafsir Al-Muyassar"
TAFSIR_PUBLISHER = "King Fahd Quran Printing Complex"
ARABIC = {
    "label": "Arabic text as returned by QuranEnc (identical across the six imported editions)",
    "source": "QuranEnc arabic_text",
}

AYAH_COUNTS = (
    7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111, 110, 98, 135,
    112, 78, 118, 64, 77, 227, 93, 88, 69, 60, 34, 30, 73, 54, 45, 83, 182, 88, 75, 85,
    54, 53, 89, 59, 37, 35, 38, 29, 18, 45, 60, 49, 62, 55, 78, 96, 29, 22, 24, 13,
    14, 11, 11, 18, 12, 12, 30, 52, 52, 44, 28, 28, 20, 56, 40, 31, 50, 40, 46, 42,
    29, 19, 36, 25, 22, 17, 19, 26, 30, 20, 15, 21, 11, 8, 8, 19, 5, 8, 8, 11,
    11, 8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5, 6,
)
SURAH_NAMES = (
    "الفاتحة", "البقرة", "آل عمران", "النساء", "المائدة", "الأنعام", "الأعراف", "الأنفال", "التوبة", "يونس",
    "هود", "يوسف", "الرعد", "إبراهيم", "الحجر", "النحل", "الإسراء", "الكهف", "مريم", "طه",
    "الأنبياء", "الحج", "المؤمنون", "النور", "الفرقان", "الشعراء", "النمل", "القصص", "العنكبوت", "الروم",
    "لقمان", "السجدة", "الأحزاب", "سبأ", "فاطر", "يس", "الصافات", "ص", "الزمر", "غافر",
    "فصلت", "الشورى", "الزخرف", "الدخان", "الجاثية", "الأحقاف", "محمد", "الفتح", "الحجرات", "ق",
    "الذاريات", "الطور", "النجم", "القمر", "الرحمن", "الواقعة", "الحديد", "المجادلة", "الحشر", "الممتحنة",
    "الصف", "الجمعة", "المنافقون", "التغابن", "الطلاق", "التحريم", "الملك", "القلم", "الحاقة", "المعارج",
    "نوح", "الجن", "المزمل", "المدثر", "القيامة", "الإنسان", "المرسلات", "النبأ", "النازعات", "عبس",
    "التكوير", "الانفطار", "المطففين", "الانشقاق", "البروج", "الطارق", "الأعلى", "الغاشية", "الفجر", "البلد",
    "الشمس", "الليل", "الضحى", "الشرح", "التين", "العلق", "القدر", "البينة", "الزلزلة", "العاديات",
    "القارعة", "التكاثر", "العصر", "الهمزة", "الفيل", "قريش", "الماعون", "الكوثر", "الكافرون", "النصر",
    "المسد", "الإخلاص", "الفلق", "الناس",
)
OFFSETS = (0,) + tuple(accumulate(AYAH_COUNTS))
TOTAL_AYAHS = OFFSETS[-1]
RANGES = {"full": (1, 114), "juz_amma": (78, 114)}
EDITION_FIELDS = (
    "key", "locale", "direction", "title", "description", "version", "last_update", "metadata_source",
    "browse_url", "api_template", "retrieved_at", "ayah_count", "footnote_ayahs",
)
TAFSIR_FIELDS = (
    "key", "locale", "kind", "label", "title", "description", "original_publisher", "delivery", "version",
    "last_update", "metadata_source", "browse_url", "api_template", "retrieved_at", "ayah_count",
)
ROW_KEYS = ("id", "sura", "aya", "arabic_text", "translation", "footnotes")
SIMPLIFIED_ONLY = "们这说为对时会从来后发与长门问关开见过还进远国"
TRADITIONAL_ONLY = "們這說為對時會從來後發與長門問關開見過還進遠國"


def surah_numbers(kind: str) -> list[int]:
    if kind not in RANGES:
        raise SnapshotError(f"unknown range {kind!r}")
    first, last = RANGES[kind]
    return list(range(first, last + 1))


def ayah_id(surah: int, aya: int) -> int:
    return OFFSETS[surah - 1] + aya


def _number(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise SnapshotError(f"{label} is not a number: {value!r}")
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isascii() and value.isdigit():
        return int(value)
    raise SnapshotError(f"{label} is not a number: {str(value)[:40]!r}")


def _json(body: bytes, label: str) -> Any:
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise SnapshotError(f"{label}: response is not UTF-8 JSON") from None


def parse_listing(body: bytes) -> dict[str, dict[str, Any]]:
    data = _json(body, "translations list")
    if not isinstance(data, dict) or not isinstance(data.get("translations"), list):
        raise SnapshotError("translations list: expected an object with a translations list")
    entries: dict[str, dict[str, Any]] = {}
    for item in data["translations"]:
        if not isinstance(item, dict) or not isinstance(item.get("key"), str):
            raise SnapshotError("translations list: entry without a key")
        if item["key"] in entries:
            raise SnapshotError(f"translations list: duplicate key {item['key']!r}")
        entries[item["key"]] = item
    return entries


def listing_metadata(entry: Mapping[str, Any], key: str, locale: str) -> dict[str, Any]:
    for field in ("direction", "title", "description", "version", "language_iso_code"):
        if not isinstance(entry.get(field), str) or not entry[field]:
            raise SnapshotError(f"{key}: listing field {field!r} is missing or empty")
    if entry["direction"] not in ("ltr", "rtl"):
        raise SnapshotError(f"{key}: unexpected direction {entry['direction']!r}")
    if entry["language_iso_code"] != SOURCE_LANGUAGE.get(locale, locale):
        raise SnapshotError(f"{key}: language_iso_code {entry['language_iso_code']!r} does not match {locale}")
    last_update = entry.get("last_update")
    if last_update is not None and (isinstance(last_update, bool) or not isinstance(last_update, int)):
        raise SnapshotError(f"{key}: last_update is not a timestamp")
    return {
        "direction": entry["direction"],
        "title": entry["title"],
        "description": entry["description"],
        "version": entry["version"],
        "last_update": last_update,
    }


def _page_text(fragment: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", fragment)).split())


def catalog_entry(page: str, key: str) -> dict[str, Any]:
    marker = f'data-share-key="{key}"'
    start = page.find(marker)
    if start < 0:
        raise SnapshotError(f"catalog: no card for {key}")
    body_start = page.rfind('class="tab_card_body"', 0, start)
    card_start = page.rfind('class="tab_card ', 0, body_start) if body_start >= 0 else -1
    titles = re.findall(r'data-share-title="([^"]+)"', page[max(0, start - 600):start])
    stamps = re.findall(r"(\d{2}/\d{2}/\d{4}) - V(\d+\.\d+\.\d+)", page[card_start:body_start]) if card_start >= 0 else []
    if not titles or len(stamps) != 1:
        raise SnapshotError(f"catalog: cannot read the card for {key}")
    title_text = html.unescape(titles[-1])
    body = _page_text(page[page.index(">", body_start) + 1:start])
    if body.startswith(title_text):
        body = body[len(title_text):]
    description = body.split(" Browse Translation", 1)[0].strip()
    if not description:
        raise SnapshotError(f"catalog: no description for {key}")
    return {"title": title_text, "description": description, "version": stamps[0][1], "date": stamps[0][0]}


def surah_names(page: str) -> dict[int, tuple[str, int]]:
    found: dict[int, tuple[str, int]] = {}
    for block in re.findall(r'<a class="surah_link[^"]*"[^>]*>(.*?)</a>', page, flags=re.S):
        number = re.search(r'<span class="surah_number">(\d+)</span>', block)
        name = re.search(r'<h2 class="fs20 fw-bolder">([^<]+)</h2>', block)
        count = re.search(r"(\d+) آية", block)
        if not number or not name or not count:
            raise SnapshotError("surah list: unexpected markup")
        n = int(number.group(1))
        if n in found:
            raise SnapshotError(f"surah list: duplicate surah {n}")
        found[n] = (html.unescape(name.group(1)).strip(), int(count.group(1)))
    if sorted(found) != list(range(1, 115)):
        raise SnapshotError("surah list: expected surahs 1 to 114")
    return found


def terms_notices(page: str) -> list[str]:
    text = _page_text(page)
    terms = re.search(r"Contents of the translations can be downloaded and re-published.*?Noble Quran\.", text)
    note = re.search(r"It is noteworthy that no matter how accurate.*?any human endeavor\.", text)
    if not terms or not note:
        raise SnapshotError("terms: the QuranEnc terms text was not found")
    return [terms.group(0), note.group(0)]


def parse_sura(body: bytes, key: str, surah: int) -> tuple[list[dict[str, Any]], int]:
    label = f"{key} surah {surah}"
    if not 1 <= surah <= 114:
        raise SnapshotError(f"{label}: surah out of range")
    data = _json(body, label)
    if not isinstance(data, dict) or not isinstance(data.get("result"), list):
        raise SnapshotError(f"{label}: expected an object with a result list")
    count = AYAH_COUNTS[surah - 1]
    rows: dict[int, dict[str, Any]] = {}
    nulls = 0
    for item in data["result"]:
        if not isinstance(item, dict):
            raise SnapshotError(f"{label}: row is not an object")
        missing = [k for k in ROW_KEYS if k not in item]
        if missing:
            raise SnapshotError(f"{label}: row is missing {', '.join(missing)}")
        sura = _number(item["sura"], f"{label} sura")
        aya = _number(item["aya"], f"{label} aya")
        row_id = _number(item["id"], f"{label} id")
        if sura != surah:
            raise SnapshotError(f"{label}: row has sura {sura}")
        if not 1 <= aya <= count:
            raise SnapshotError(f"{label}: aya {aya} is out of range 1..{count}")
        if aya in rows:
            raise SnapshotError(f"{label}: duplicate aya {aya}")
        if row_id != ayah_id(surah, aya):
            raise SnapshotError(f"{label}: aya {aya} has id {row_id}, expected {ayah_id(surah, aya)}")
        arabic, translation, footnotes = item["arabic_text"], item["translation"], item["footnotes"]
        if not isinstance(arabic, str) or not arabic.strip():
            raise SnapshotError(f"{label}: aya {aya} has no arabic_text")
        if not isinstance(translation, str) or not translation.strip():
            raise SnapshotError(f"{label}: aya {aya} has an empty translation")
        if footnotes is None:
            footnotes = ""
            nulls += 1
        elif not isinstance(footnotes, str):
            raise SnapshotError(f"{label}: aya {aya} has non-text footnotes")
        rows[aya] = {"aya": aya, "id": row_id, "arabic_text": arabic, "translation": translation, "footnotes": footnotes}
    absent = [a for a in range(1, count + 1) if a not in rows]
    if absent:
        raise SnapshotError(f"{label}: missing aya {', '.join(map(str, absent[:10]))}")
    return [rows[a] for a in range(1, count + 1)], nulls


def script_counts(texts: Sequence[str]) -> dict[str, int]:
    joined = "".join(texts)
    return {
        "simplified_only": sum(joined.count(c) for c in SIMPLIFIED_ONLY),
        "traditional_only": sum(joined.count(c) for c in TRADITIONAL_ONLY),
    }


def build_files(
    editions: Sequence[Mapping[str, Any]],
    texts: Mapping[str, Mapping[int, Sequence[Mapping[str, Any]]]],
    surahs: Sequence[int],
    notices: Sequence[str],
    tafsir: Optional[Mapping[str, Any]] = None,
    tafsir_rows: Optional[Mapping[int, Sequence[Mapping[str, Any]]]] = None,
) -> dict[str, bytes]:
    if [e["key"] for e in editions] != list(EDITION_KEYS) or [e["locale"] for e in editions] != list(LOCALES):
        raise SnapshotError("editions must be the six Balligh editions in order")
    surahs = list(surahs)
    if surahs not in (surah_numbers("full"), surah_numbers("juz_amma")):
        raise SnapshotError("surahs must be the full Quran or Juz' Amma")
    files: dict[str, bytes] = {}
    entries = []
    quarantine = []
    counts = {key: [0, 0] for key in EDITION_KEYS}
    tafsir_count = 0
    for n in surahs:
        ayahs = []
        for index in range(AYAH_COUNTS[n - 1]):
            rows = {key: texts[key][n][index] for key in EDITION_KEYS}
            aya = index + 1
            if any(row["aya"] != aya or row["id"] != ayah_id(n, aya) for row in rows.values()) or (
                    tafsir_rows is not None and tafsir_rows[n][index]["aya"] != aya):
                raise SnapshotError(f"surah {n}: rows are not in ayah order at aya {aya}")
            arabic = {key: row["arabic_text"] for key, row in rows.items()}
            if len(set(arabic.values())) != 1:
                quarantine.append({
                    "surah": n,
                    "aya": aya,
                    "id": ayah_id(n, aya),
                    "arabic_sha256": {key: bytes_hash(value.encode("utf-8")) for key, value in arabic.items()},
                })
                continue
            layer = {}
            if tafsir is not None and tafsir_rows is not None:
                layer[tafsir["key"]] = tafsir_rows[n][index]["translation"]
                tafsir_count += 1
            for key, row in rows.items():
                counts[key][0] += 1
                counts[key][1] += 1 if row["footnotes"] != "" else 0
            ayahs.append({
                "aya": aya,
                "id": ayah_id(n, aya),
                "arabic": arabic[EDITION_KEYS[0]],
                "translations": {
                    locale: {"text": rows[key]["translation"], "footnotes": rows[key]["footnotes"]}
                    for key, locale in EDITIONS
                },
                "tafsir": layer,
            })
        rel = f"surahs/{n:03d}.json"
        data = file_bytes({
            "schema": SURAH_SCHEMA,
            "number": n,
            "name_ar": SURAH_NAMES[n - 1],
            "ayah_count": AYAH_COUNTS[n - 1],
            "ayahs": ayahs,
            "content_sha256": content_hash(ayahs),
        })
        files[rel] = data
        entries.append({"number": n, "name_ar": SURAH_NAMES[n - 1], "ayah_count": AYAH_COUNTS[n - 1], "file": rel, "sha256": bytes_hash(data)})
    delivered = sum(c[0] for c in counts.values()) // len(EDITION_KEYS)
    kind = "full" if surahs[0] == 1 else "juz_amma"
    index = {
        "schema": INDEX_SCHEMA,
        "range": {
            "kind": kind if not quarantine else "partial",
            "surah_first": surahs[0],
            "surah_last": surahs[-1],
            "surah_count": len(surahs),
            "ayah_count": delivered,
        },
        "arabic": dict(ARABIC),
        "editions": [
            {**{f: e[f] for f in EDITION_FIELDS if f not in ("ayah_count", "footnote_ayahs")},
             "ayah_count": counts[e["key"]][0], "footnote_ayahs": counts[e["key"]][1]}
            for e in editions
        ],
        "tafsir": [] if tafsir is None else [{**{f: tafsir[f] for f in TAFSIR_FIELDS if f != "ayah_count"}, "ayah_count": tafsir_count}],
        "surahs": entries,
        "quarantine": quarantine,
        "notices": list(notices),
    }
    files["index.json"] = file_bytes(index)
    return files


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise SnapshotError(message)


def _is_text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate_quran_dir(path: Path) -> dict[str, Any]:
    base = Path(path)
    index = read_json(base, "index.json")
    _require(isinstance(index, dict) and index.get("schema") == INDEX_SCHEMA, "index: unexpected schema")
    expected_keys = {"schema", "range", "arabic", "editions", "tafsir", "surahs", "quarantine", "notices"}
    _require(set(index) == expected_keys, "index: unexpected top-level fields")
    span = index["range"]
    _require(isinstance(span, dict) and set(span) == {"kind", "surah_first", "surah_last", "surah_count", "ayah_count"}, "index: malformed range")
    numbers = list(range(span["surah_first"], span["surah_last"] + 1)) if all(
        isinstance(span[f], int) and not isinstance(span[f], bool) for f in ("surah_first", "surah_last")) else []
    _require(numbers in (surah_numbers("full"), surah_numbers("juz_amma")), "index: range must be the full Quran or Juz' Amma")
    _require(span["surah_count"] == len(numbers), "index: surah_count does not match the range")
    _require(index["arabic"] == ARABIC, "index: unexpected arabic label")
    _require(isinstance(index["notices"], list) and all(_is_text(n) for n in index["notices"]), "index: notices must be text")
    editions = index["editions"]
    _require(isinstance(editions, list) and [e.get("key") if isinstance(e, dict) else None for e in editions] == list(EDITION_KEYS), "index: editions must be the six Balligh editions in order")
    for e, locale in zip(editions, LOCALES):
        _require(set(e) == set(EDITION_FIELDS), f"index: edition {e['key']} has unexpected fields")
        _require(e["locale"] == locale and e["direction"] in ("ltr", "rtl"), f"index: edition {e['key']} has a wrong locale or direction")
        for f in ("title", "description", "version", "metadata_source", "browse_url", "api_template", "retrieved_at"):
            _require(_is_text(e[f]), f"index: edition {e['key']} field {f} is empty")
        _require(e["api_template"] == SURA_URL.replace("{key}", e["key"]), f"index: edition {e['key']} api_template mismatch")
    tafsir = index["tafsir"]
    _require(isinstance(tafsir, list) and len(tafsir) <= 1, "index: tafsir must be a list of at most one layer")
    tafsir_keys = []
    for t in tafsir:
        _require(isinstance(t, dict) and set(t) == set(TAFSIR_FIELDS), "index: tafsir layer has unexpected fields")
        _require(t["key"] == TAFSIR_KEY and t["locale"] == "ar" and t["kind"] == "tafsir", "index: unexpected tafsir layer")
        _require(t["original_publisher"] == TAFSIR_PUBLISHER and t["delivery"] == "QuranEnc", "index: tafsir provenance mismatch")
        tafsir_keys.append(t["key"])
    quarantine = index["quarantine"]
    _require(isinstance(quarantine, list), "index: quarantine must be a list")
    held: dict[int, set[int]] = {}
    for q in quarantine:
        _require(isinstance(q, dict) and set(q) == {"surah", "aya", "id", "arabic_sha256"}, "index: malformed quarantine entry")
        _require(all(type(q[f]) is int for f in ("surah", "aya", "id")), "index: malformed quarantine entry")
        _require(q["surah"] in numbers and 1 <= q["aya"] <= AYAH_COUNTS[q["surah"] - 1] and q["id"] == ayah_id(q["surah"], q["aya"]), "index: quarantine entry outside the range")
        _require(isinstance(q["arabic_sha256"], dict) and set(q["arabic_sha256"]) == set(EDITION_KEYS) and len(set(q["arabic_sha256"].values())) > 1, "index: quarantine entry without a disagreement")
        _require(q["aya"] not in held.get(q["surah"], set()), "index: duplicate quarantine entry")
        held.setdefault(q["surah"], set()).add(q["aya"])
    kind = ("full" if numbers[0] == 1 else "juz_amma") if not quarantine else "partial"
    _require(span["kind"] == kind, f"index: range kind must be {kind!r}")
    entries = index["surahs"]
    _require(isinstance(entries, list) and [s.get("number") if isinstance(s, dict) else None for s in entries] == numbers, "index: surah list does not match the range")
    counts = {key: [0, 0] for key in EDITION_KEYS}
    tafsir_count = 0
    seen_ids: set[int] = set()
    for entry in entries:
        n = entry["number"]
        _require(set(entry) == {"number", "name_ar", "ayah_count", "file", "sha256"}, f"index: surah {n} entry has unexpected fields")
        doc = read_verified(base, entry["file"], entry["sha256"])
        _require(entry["file"] == f"surahs/{n:03d}.json", f"index: surah {n} has an unexpected file name")
        _require(entry["name_ar"] == SURAH_NAMES[n - 1] and entry["ayah_count"] == AYAH_COUNTS[n - 1], f"index: surah {n} name or ayah count mismatch")
        _require(isinstance(doc, dict) and set(doc) == {"schema", "number", "name_ar", "ayah_count", "ayahs", "content_sha256"}, f"surah {n}: unexpected fields")
        _require(doc["schema"] == SURAH_SCHEMA and doc["number"] == n, f"surah {n}: wrong schema or number")
        _require(doc["name_ar"] == entry["name_ar"] and doc["ayah_count"] == entry["ayah_count"], f"surah {n}: header does not match the index")
        ayahs = doc["ayahs"]
        _require(isinstance(ayahs, list), f"surah {n}: ayahs must be a list")
        _require(doc["content_sha256"] == content_hash(ayahs), f"surah {n}: content hash mismatch")
        expected = [a for a in range(1, AYAH_COUNTS[n - 1] + 1) if a not in held.get(n, set())]
        _require([a.get("aya") if isinstance(a, dict) else None for a in ayahs] == expected, f"surah {n}: ayah set does not match the expected set")
        for a in ayahs:
            label = f"surah {n} aya {a['aya']}"
            _require(set(a) == {"aya", "id", "arabic", "translations", "tafsir"}, f"{label}: unexpected fields")
            _require(a["id"] == ayah_id(n, a["aya"]) and a["id"] not in seen_ids, f"{label}: wrong or duplicate id")
            seen_ids.add(a["id"])
            _require(_is_text(a["arabic"]), f"{label}: empty arabic")
            tr = a["translations"]
            _require(isinstance(tr, dict) and set(tr) == set(LOCALES), f"{label}: translations must cover the six locales")
            for key, locale in EDITIONS:
                item = tr[locale]
                _require(isinstance(item, dict) and set(item) == {"text", "footnotes"}, f"{label}: malformed {locale} translation")
                _require(_is_text(item["text"]) and isinstance(item["footnotes"], str), f"{label}: empty {locale} translation")
                counts[key][0] += 1
                counts[key][1] += 1 if item["footnotes"] != "" else 0
            layer = a["tafsir"]
            _require(isinstance(layer, dict) and sorted(layer) == sorted(tafsir_keys), f"{label}: tafsir layers do not match the index")
            for key in tafsir_keys:
                _require(_is_text(layer[key]), f"{label}: empty tafsir")
                tafsir_count += 1
    delivered = len(seen_ids)
    _require(span["ayah_count"] == delivered, "index: range ayah_count does not match the files")
    expected_total = sum(AYAH_COUNTS[n - 1] for n in numbers) - len(quarantine)
    _require(delivered == expected_total, "index: delivered ayahs do not match the expected set")
    for e in editions:
        _require(e["ayah_count"] == counts[e["key"]][0] and e["footnote_ayahs"] == counts[e["key"]][1], f"index: edition {e['key']} counts do not match the files")
    for t in tafsir:
        _require(t["ayah_count"] == tafsir_count == delivered, "index: tafsir layer is incomplete")
    return {
        "range": dict(span),
        "surahs": len(entries),
        "ayahs": delivered,
        "editions": {e["key"]: {"locale": e["locale"], "ayahs": counts[e["key"]][0], "footnote_ayahs": counts[e["key"]][1]} for e in editions},
        "tafsir": {t["key"]: t["ayah_count"] for t in tafsir},
        "quarantine": len(quarantine),
        "files": len(entries) + 1,
    }
