from __future__ import annotations

import argparse
import json
import os
import sys
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Optional, Sequence

SERVER = Path(__file__).resolve().parents[2]
APP_ROOT = SERVER.parent
if str(SERVER) not in sys.path:
    sys.path.insert(0, str(SERVER))

from balligh.library import hadith, snapshot
from balligh.library.fetch import FetchError, Fetched, Fetcher

CACHE_DIR = APP_ROOT / "var" / "library-cache" / "hadith"
LIVE_DIR = APP_ROOT / "content" / "library"
TARGET_DIR = APP_ROOT / "var" / "library-staging" / "hadith"
CATEGORIES_URL = f"{hadith.API_BASE}/categories/list/?language=ar"
DORAR_URL = "https://dorar.net/h/MXnb6eUb"
DORAR_STATUS_FILE = "dorar-status.json"
PER_PAGE = 100
WORKERS = 2
TERMS_URL = "https://hadeethenc.com/en/home"
TERMS_URL_AR = "https://hadeethenc.com/ar/home"
TERMS_RETRIEVED = "2026-10-06T03:38:35+00:00"

PLAN: tuple[tuple[str, int, tuple[str, ...]], ...] = (
    ("understanding_islam", 30, ("88", "91", "95", "94", "92", "81")),
    ("belief", 35, ("73", "271", "72", "79", "86", "75")),
    ("worship", 45, ("133", "134", "137", "136", "278")),
    ("conduct", 40, ("282", "273", "287", "286", "290")),
)

RATIONALE = (
    "Beginner-relevant HadeethEnc subcategories for people exploring Islam and new Muslims: what Islam, iman and ihsan are "
    "and the Prophet (understanding_islam); tawhid, prophethood, angels and qadar basics (belief); purification, prayer, "
    "fasting, zakat and remembrance (worship); good character, parents, speech, greetings and eating manners (conduct). "
    "Candidates are taken in the publisher's list order, interleaved across the categories of each topic, first-seen category "
    "wins for duplicates, records listed in all six Balligh translation languages are preferred, and only records whose Arabic "
    "grade field is exactly صحيح are admitted."
)

TERMS_EN = (
    "Terms and Policies: Contents of the translations can be downloaded and re-published, with the following terms and conditions: "
    "1. No modification, addition, or deletion of the content. "
    "2. Clearly referring to the publisher and the source (HadeethEnc.com). "
    "3. Mentioning the version number when re-publishing the translation. "
    "4. Keeping the transcript information inside the document. "
    "5. Notifying the source (HadeethEnc.com) of any note on the translation. "
    "6. Updating the translation according to the latest version issued from the source (HadeethEnc.com). "
    "7. Inappropriate advertisements must not be included when displaying the content of the Prophet’s Hadiths and their translations."
)

TERMS_AR = (
    "الشروط والسياسات: "
    "يتاح  تنزيل محتوى الترجمات "
    "وإعادة نشره، بالشروط والضوابط "
    "التالية: "
    "1. عدم التعديل أو الإضافة أو الحذف "
    "على المحتوى. "
    "2. الإشارة بوضوح للناشر وللمصدر (HadeethEnc.com). "
    "3. ذكر رقم الإصدار عند إعادة نشر "
    "الترجمة. "
    "4. إبقاء معلومات نسخة الترجمة "
    "الموجودة داخل المستند. "
    "5. إفادة المصدر (HadeethEnc.com) بأي ملاحظة "
    "على الترجمة. "
    "6. تطوير الترجمات وفق النسخ "
    "الجديدة الصادرة من المصدر (HadeethEnc.com). "
    "7. عدم تضمين إعلانات لا تليق "
    "بمحتوى الأحاديث النبوية "
    "وترجماتها عند العرض."
)


def notices() -> list[str]:
    return [
        f"HadeethEnc.com terms (quoted unchanged from the Terms and Policies dialog of {TERMS_URL}, retrieved {TERMS_RETRIEVED}): {TERMS_EN}",
        f"HadeethEnc.com terms in Arabic (quoted unchanged from {TERMS_URL_AR}, retrieved {TERMS_RETRIEVED}): {TERMS_AR}",
        "Publisher and source: HadeethEnc.com (Encyclopedia of Translated Prophetic Hadiths). Every record links its HadeethEnc page "
        "(source.url / translations.*.source_url) and the API response it was built from (api_url).",
        "Version: HadeethEnc's terms require mentioning the version number when re-publishing a translation. The API responses "
        "carry no version field (/api/v1 is the API path, not a content version). The official English translation download "
        "(https://hadeethenc.com/browse/download/en, served as HadeethEnc.com_en-v1.25.0.xlsx, header 'Last update: 2026-05-10 "
        "17:43:35 (v1.25.0)', checked 2026-10-06) is versioned v1.25.0, but HadeethEnc does not state which version the API "
        "content is, and the other languages' files were not checked. No version is claimed for the stored content; each record "
        "and translation stores its retrieval time and content_sha256, and the identifier to cite is an open question for the publisher.",
        "Content is stored unchanged: Arabic hadeeth text, attribution, grade, reference, explanation, hints and the word notes "
        "(words_meanings, each {word, meaning} exactly as published, language ar) are the publisher's fields verbatim, kept as "
        "separate fields; explanations, hints and word notes are HadeethEnc's published commentary, never part of the hadith text.",
        "A translation is admitted only when its hadeeth_ar equals the selected Arabic record's hadeeth exactly (arabic_match exact) "
        "or the response has no hadeeth_ar (arabic_match not_provided, never called exact); a differing hadeeth_ar rejects the "
        "translation with no fallback to another narration. Translation word notes are stored only when the response gives "
        "its own-language words_meanings; the Arabic words_meanings_ar copy is never stored as a localized note.",
        f"Grades are HadeethEnc's own (grading_authority: {hadith.GRADING_AUTHORITY}); only an Arabic grade field exactly equal to "
        f"{hadith.REQUIRED_GRADE} is admitted. Balligh does not grade hadith.",
        "Dorar.net cross-checking of wording, reference and grade was not possible (see each record's dorar block); it was not bypassed.",
        "narrator is null: HadeethEnc has no separate narrator field; the narrator is part of the hadeeth text.",
        "Translations are HadeethEnc's own translations of the same record id; Balligh creates no translation or explanation. "
        "zh-Hans is HadeethEnc language code zh (Simplified Chinese).",
        "content_sha256 = snapshot.content_hash(object without its content_sha256); a record's hash covers its translations.",
        "review_status source_preserved: ingestion checks only, no Balligh human, scholarly or language review. "
        "reuse_basis hadeethenc_terms: HadeethEnc's own terms apply; the Ibn Baz / Dorar permission does not replace them.",
    ]


class Source:
    def __init__(self, fetcher: Fetcher):
        self.fetcher = fetcher
        self.cache_hits = 0
        self._lock = threading.Lock()

    def get(self, url: str) -> Fetched:
        item = self.fetcher.get(url)
        if item.from_cache:
            with self._lock:
                self.cache_hits += 1
        return item

    def many(self, urls: Sequence[str]) -> list[Fetched]:
        if not urls:
            return []
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            return list(pool.map(self.get, urls))


def dorar_status(fetcher: Fetcher, cache_dir: Path) -> dict[str, str]:
    path = Path(cache_dir) / DORAR_STATUS_FILE
    if fetcher.offline:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = None
        if isinstance(data, dict) and data.get("status") == "not_verified" and isinstance(data.get("reason"), str) and data["reason"].strip():
            return {"status": "not_verified", "reason": data["reason"]}
        return {"status": "not_verified", "reason": "no Dorar check is recorded in the importer cache; Dorar cross-checking was not performed"}
    day = fetcher.now().date().isoformat()
    try:
        fetcher.get(DORAR_URL)
    except FetchError as e:
        observed = f"HTTP {e.status}" if e.status is not None else str(e)
        reason = (f"{DORAR_URL} answered {observed} to the identified Balligh importer on {day} (one request, not bypassed); "
                  "Dorar wording, reference and grade cross-checking was not performed")
    else:
        reason = (f"{DORAR_URL} was reachable on {day}, but no automated Dorar cross-check is implemented; "
                  "wording, reference and grade were not verified against Dorar")
    status = {"status": "not_verified", "reason": reason}
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(json.dumps(status, ensure_ascii=False, indent=1).encode("utf-8"))
    os.replace(tmp, path)
    return status


def quotas(target: int) -> dict[str, int]:
    weights = [w for _t, w, _c in PLAN]
    total = sum(weights)
    out = {t: target * w // total for t, w, _c in PLAN}
    rest = target - sum(out.values())
    for t, _w, _c in PLAN:
        if rest <= 0:
            break
        out[t] += 1
        rest -= 1
    return out


class Selection:
    def __init__(self, source: Source):
        self.source = source
        self.details: dict[str, Fetched] = {}
        self.payloads: dict[str, dict[str, Any]] = {}
        self.outcomes: dict[tuple[str, str], tuple[Optional[dict[str, Any]], str, bool]] = {}
        self.processed: set[str] = set()
        self.deferred: set[str] = set()
        self.admitted: list[dict[str, Any]] = []
        self.exclusions: list[dict[str, str]] = []
        self.decisions: list[list[str]] = []
        self.grades: Counter = Counter()

    def prefetch(self, ids: Sequence[str]) -> None:
        todo = [i for i in ids if i not in self.details]
        for rid, item in zip(todo, self.source.many([hadith.detail_url("ar", i) for i in todo])):
            self.details[rid] = item

    def arabic(self, rid: str) -> tuple[Optional[dict[str, Any]], str]:
        if rid in self.payloads:
            return self.payloads[rid], ""
        try:
            payload = hadith.check_detail(self.details[rid].json(), rid)
        except (hadith.ShapeError, ValueError) as e:
            return None, f"malformed detail response: {e}"
        self.payloads[rid] = payload
        return payload, ""

    def translate(self, ids: Sequence[str]) -> None:
        jobs = []
        for rid in ids:
            for locale, code in hadith.SOURCE_CODES.items():
                if code in self.payloads[rid]["translations"] and (rid, locale) not in self.outcomes:
                    jobs.append((rid, locale))
        urls = [hadith.detail_url(hadith.SOURCE_CODES[loc], rid) for rid, loc in jobs]
        for (rid, locale), item in zip(jobs, self.source.many(urls)):
            payload = self.payloads[rid]
            try:
                tr = hadith.check_translation(item.json(), rid, payload)
            except hadith.NarrationMismatch as e:
                self.outcomes[(rid, locale)] = (None, str(e), "mismatch")
                continue
            except (hadith.ShapeError, ValueError) as e:
                self.outcomes[(rid, locale)] = (None, f"rejected translation response: {e}", "rejected")
                continue
            entry = hadith.build_translation(locale, tr, item.retrieved_at, payload)
            self.outcomes[(rid, locale)] = (entry, "", entry["arabic_match"])

    def complete(self, rid: str) -> bool:
        return all(self.outcomes.get((rid, loc), (None, "", ""))[0] is not None for loc in hadith.SOURCE_CODES)

    def process(self, cand: dict[str, Any], complete: bool) -> bool:
        rid = cand["id"]
        payload, problem = self.arabic(rid)
        if payload is None:
            self.processed.add(rid)
            self._exclude(cand, problem)
            return False
        reason = hadith.admission(payload)
        if reason is None and complete and not self.complete(rid):
            self.deferred.add(rid)
            return False
        self.processed.add(rid)
        grade = payload.get("grade")
        self.grades["<missing>" if grade is None else grade] += 1
        if reason is not None:
            self._exclude(cand, reason)
            return False
        self.admitted.append({"cand": cand, "payload": payload, "retrieved_at": self.details[rid].retrieved_at})
        self.decisions.append([rid, cand["category"], cand["topic"], "admitted"])
        return True

    def _exclude(self, cand: dict[str, Any], reason: str) -> None:
        self.exclusions.append({"source_record_id": cand["id"], "reason": reason})
        self.decisions.append([cand["id"], cand["category"], cand["topic"], f"excluded: {reason}"])

    def run(self, candidates: Sequence[dict[str, Any]], quota: int, accept: Callable[[dict[str, Any]], bool],
            complete: bool) -> int:
        queue = [c for c in candidates
                 if c["id"] not in self.processed and accept(c) and not (complete and c["id"] in self.deferred)]
        admitted = 0
        i = 0
        while admitted < quota and i < len(queue):
            window = queue[i:i + max(4, 2 * (quota - admitted))]
            self.prefetch([c["id"] for c in window])
            if complete:
                self.translate([c["id"] for c in window if self.arabic(c["id"])[0] is not None
                                and hadith.admission(self.payloads[c["id"]]) is None])
            for cand in window:
                if admitted >= quota:
                    break
                i += 1
                if self.process(cand, complete):
                    admitted += 1
        return admitted


def full_listing(cand: dict[str, Any]) -> bool:
    return all(code in cand["translations"] for code in hadith.SOURCE_CODES.values())


def build_candidates(lists: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    seen: set[str] = set()
    out: dict[str, list[dict[str, Any]]] = {}
    for topic, _w, cats in PLAN:
        rows: list[dict[str, Any]] = []
        depth = max((len(lists[c]) for c in cats), default=0)
        for pos in range(depth):
            for cat in cats:
                if pos < len(lists[cat]):
                    item = lists[cat][pos]
                    if item["id"] in seen:
                        continue
                    seen.add(item["id"])
                    rows.append({**item, "category": cat, "topic": topic})
        out[topic] = rows
    return out


class ShortCollection(Exception):
    def __init__(self, count: int, minimum: int):
        super().__init__(f"only {count} records qualified, below the minimum {minimum}; nothing was published")
        self.count = count
        self.minimum = minimum


def inside_live(path: Path) -> bool:
    return snapshot.overlaps(path, LIVE_DIR)


def run_import(fetcher: Fetcher, *, cache_dir: Path, target_dir: Path, target: int = 150,
               maximum: int = 200) -> dict[str, Any]:
    minimum = hadith.MIN_COUNT
    if not minimum <= target <= maximum <= hadith.MAX_COUNT:
        raise SystemExit("--target must be between 100 and --max, and --max at most 200")
    source = Source(fetcher)
    dorar = dorar_status(fetcher, cache_dir)
    labels_full = hadith.check_categories(source.get(CATEGORIES_URL).json())
    labels = {k: v["title"] for k, v in labels_full.items()}
    all_cats = [c for _t, _w, cats in PLAN for c in cats]
    lists: dict[str, list[dict[str, Any]]] = {}
    category_rows = []
    for cat, item in zip(all_cats, source.many([hadith.list_url(c, 1, PER_PAGE) for c in all_cats])):
        rows, meta = hadith.check_list(item.json())
        lists[cat] = rows
        topic = next(t for t, _w, cats in PLAN if cat in cats)
        category_rows.append({"id": cat, "label": labels.get(cat), "parent_id": labels_full.get(cat, {}).get("parent_id"),
                              "topic": topic, "list_total": meta["total_items"], "entries_considered": len(rows),
                              "list_url": hadith.list_url(cat, 1, PER_PAGE)})
    candidates = build_candidates(lists)
    sel = Selection(source)
    per_topic = quotas(target)
    for topic, _w, _c in PLAN:
        sel.run(candidates[topic], per_topic[topic], full_listing, True)
    for accept, complete in ((full_listing, True), (lambda c: True, False)):
        for topic, _w, _c in PLAN:
            remaining = target - len(sel.admitted)
            if remaining <= 0:
                break
            sel.run(candidates[topic], remaining, accept, complete)
    undecided = sum(1 for rows in candidates.values() for c in rows if c["id"] not in sel.processed)

    sel.translate([entry["payload"]["id"] for entry in sel.admitted])
    missing: list[dict[str, str]] = []
    per_record: dict[int, dict[str, dict[str, Any]]] = {}
    matches: Counter = Counter({"exact": 0, "not_provided": 0, "mismatch": 0})
    mismatched: list[list[str]] = []
    for idx, entry in enumerate(sel.admitted):
        rid = entry["payload"]["id"]
        for locale, code in hadith.SOURCE_CODES.items():
            if code not in entry["payload"]["translations"]:
                missing.append({"source_record_id": rid, "locale": locale, "reason": "not listed in the record's translations"})
                continue
            tr, problem, match = sel.outcomes[(rid, locale)]
            if match in matches:
                matches[match] += 1
            if tr is None:
                if match == "mismatch":
                    mismatched.append([rid, locale])
                missing.append({"source_record_id": rid, "locale": locale, "reason": problem})
                continue
            per_record.setdefault(idx, {})[locale] = tr

    records = [
        hadith.build_record(entry["payload"], entry["retrieved_at"], entry["cand"]["topic"], labels, dorar, per_record.get(idx, {}))
        for idx, entry in enumerate(sel.admitted)
    ]
    count = len(records)
    if count < minimum:
        raise ShortCollection(count, minimum)
    notes = {
        "records_with_words_meanings": sum(1 for r in records if r["words_meanings"]),
        "arabic_word_notes": sum(len(r["words_meanings"]) for r in records),
        "translations_with_localized_words_meanings": sum(
            1 for r in records for t in r["translations"].values() if t["words_meanings"]),
    }
    selection = {
        "categories": category_rows,
        "topic_map": {c: t for t, _w, cats in PLAN for c in cats},
        "topic_quotas": per_topic,
        "rationale": RATIONALE,
        "admission_rule": f"Arabic grade field exactly {hadith.REQUIRED_GRADE!r}; any other value or a missing grade is excluded",
        "target": target,
        "maximum": maximum,
        "minimum": minimum,
        "grade_distribution": dict(sorted(sel.grades.items())),
        "candidates": sum(len(v) for v in candidates.values()),
        "candidates_not_decided": undecided,
        "deferred_incomplete_translations": sorted(sel.deferred - sel.processed, key=int),
        "missing_translations": missing,
        "arabic_match": dict(matches),
        "hadeeth_ar_mismatch_rejected": mismatched,
        "word_notes": notes,
        "decisions": sel.decisions,
        "dorar": dorar,
    }
    files = hadith.build_files(records, sel.exclusions, selection, notices())
    summary = snapshot.publish(target_dir, files, hadith.validate_hadith_dir)
    return {
        "published": str(target_dir),
        "validation": summary,
        "count": count,
        "full_seven_locales": summary["full_locale_records"],
        "per_locale": summary["locales"],
        "topics": summary["topics"],
        "grades_seen": dict(sorted(sel.grades.items())),
        "exclusions": len(sel.exclusions),
        "missing_translations": len(missing),
        "candidates_not_decided": undecided,
        "deferred_incomplete_translations": len(sel.deferred - sel.processed),
        "arabic_match": dict(matches),
        "word_notes": notes,
        "dorar": dorar,
        "network_requests": fetcher.network_requests,
        "cache_hits": source.cache_hits,
        "failures": fetcher.failures,
        "offline": fetcher.offline,
        "files": len(files),
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Import authentic hadith records from HadeethEnc.com")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--out", type=Path, default=TARGET_DIR)
    parser.add_argument("--target", type=int, default=150)
    parser.add_argument("--max", dest="maximum", type=int, default=200)
    args = parser.parse_args(argv)
    if inside_live(args.out):
        print(f"refusing --out {args.out}: it is, contains or is inside the live library {LIVE_DIR}", file=sys.stderr)
        return 2
    fetcher = Fetcher(CACHE_DIR, offline=args.offline)
    try:
        result = run_import(fetcher, cache_dir=CACHE_DIR, target_dir=args.out, target=args.target, maximum=args.maximum)
    except ShortCollection as e:
        print(json.dumps({"error": str(e), "count": e.count, "minimum": e.minimum, "published": None},
                         ensure_ascii=False, indent=1, sort_keys=True))
        return 1
    finally:
        fetcher.close()
    print(json.dumps(result, ensure_ascii=False, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
