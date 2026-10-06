import argparse
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Optional

APP_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(APP_ROOT / "server"))

from balligh.library import quran
from balligh.library.fetch import FetchError, Fetched, Fetcher
from balligh.library.snapshot import SnapshotError, bytes_hash, content_hash, overlaps, publish

LIVE = APP_ROOT / "content" / "library"
TARGET = LIVE / "quran"
STAGING = APP_ROOT / "var" / "library-staging" / "quran"
CACHE = APP_ROOT / "var" / "library-cache" / "quran"


class Session:
    def __init__(self, fetcher: Fetcher):
        self.fetcher = fetcher
        self.requests = 0
        self.cache_hits = 0
        self._lock = threading.Lock()
        self._pages: dict[str, Fetched] = {}

    def get(self, url: str) -> Fetched:
        if url in self._pages:
            return self._pages[url]
        item = self.fetcher.get(url)
        with self._lock:
            self.requests += 1
            self.cache_hits += 1 if item.from_cache else 0
            self._pages.setdefault(url, item)
        return item

    def stats(self) -> dict[str, Any]:
        return {
            "requests": self.requests,
            "cache_hits": self.cache_hits,
            "network_requests": self.fetcher.network_requests,
            "failures": list(self.fetcher.failures),
        }


def fetch_surahs(session: Session, key: str, surahs: list[int]) -> tuple[dict[int, list], int, str, list[str]]:
    def one(n: int) -> tuple[int, Any, int, str]:
        try:
            item = session.get(quran.SURA_URL.format(key=key, surah=n))
            rows, nulls = quran.parse_sura(item.body, key, n)
        except (FetchError, SnapshotError) as e:
            return n, f"{key} surah {n}: {e}", 0, ""
        return n, rows, nulls, item.retrieved_at

    texts: dict[int, list] = {}
    errors: list[str] = []
    nulls = 0
    latest = ""
    with ThreadPoolExecutor(max_workers=2) as pool:
        for n, rows, count, retrieved_at in pool.map(one, surahs):
            if isinstance(rows, str):
                errors.append(rows)
                continue
            texts[n] = rows
            nulls += count
            latest = max(latest, retrieved_at)
    return texts, nulls, latest, errors


def metadata(session: Session, key: str, locale: str, listing: dict[str, dict]) -> tuple[dict[str, Any], Optional[dict]]:
    if key in listing:
        return {**quran.listing_metadata(listing[key], key, locale), "metadata_source": quran.LIST_URL}, None
    language_url = f"{quran.LIST_URL}/{quran.SOURCE_LANGUAGE.get(locale, locale)}"
    narrowed = quran.parse_listing(session.get(language_url).body)
    if key in narrowed:
        return {**quran.listing_metadata(narrowed[key], key, locale), "metadata_source": language_url}, None
    card = quran.catalog_entry(session.get(quran.CATALOG_URL).text(), key)
    other = quran.catalog_entry(session.get(quran.CATALOG_AR_URL).text(), key)
    if (other["date"], other["version"]) != (card["date"], card["version"]):
        raise SnapshotError(
            f"{key}: catalog pages disagree: {quran.CATALOG_URL} shows {card['date']} - V{card['version']}, "
            f"{quran.CATALOG_AR_URL} shows {other['date']} - V{other['version']}"
        )
    return {
        "direction": "rtl" if locale == "ar" else "ltr",
        "title": card["title"],
        "description": card["description"],
        "version": card["version"],
        "last_update": None,
        "metadata_source": quran.CATALOG_URL,
    }, {"key": key, "language_url": language_url, **card}


def run(fetcher: Fetcher, target: Path = TARGET, kind: str = "full", tafsir: bool = True) -> dict[str, Any]:
    session = Session(fetcher)
    surahs = quran.surah_numbers(kind)
    listing_item = session.get(quran.LIST_URL)
    listing = quran.parse_listing(listing_item.body)
    terms_item = session.get(quran.TERMS_URL)
    terms, note = quran.terms_notices(terms_item.text())
    names_item = session.get(quran.NAMES_URL)
    names = quran.surah_names(names_item.text())
    miscounted = [n for n in range(1, 115) if names[n][1] != quran.AYAH_COUNTS[n - 1]]
    if miscounted:
        raise SnapshotError(f"ayah counts differ from {quran.NAMES_URL} for surahs {miscounted[:10]}")
    spelled = [n for n in range(1, 115) if names[n][0] != quran.SURAH_NAMES[n - 1]]

    editions = []
    texts: dict[str, dict[int, list]] = {}
    nulls: dict[str, int] = {}
    cards = []
    errors: list[str] = []
    for key, locale in quran.EDITIONS:
        meta, card = metadata(session, key, locale, listing)
        if card:
            cards.append(card)
        rows, null_count, latest, failed = fetch_surahs(session, key, surahs)
        errors.extend(failed)
        texts[key] = rows
        nulls[key] = null_count
        editions.append({
            "key": key,
            "locale": locale,
            **meta,
            "browse_url": quran.BROWSE_URL.format(key=key),
            "api_template": quran.SURA_URL.replace("{key}", key),
            "retrieved_at": latest,
        })
    if errors:
        raise SnapshotError(f"{len(errors)} surah responses failed validation or fetching; first: {errors[0]}")

    script = quran.script_counts([row["translation"] for n in surahs for row in texts["chinese_suliman"][n]])
    if script["simplified_only"] <= script["traditional_only"]:
        raise SnapshotError(f"chinese_suliman does not read as Simplified Chinese: {script}")

    tafsir_meta = None
    tafsir_rows = None
    tafsir_status: dict[str, Any] = {"requested": tafsir, "delivered": False}
    if tafsir:
        try:
            meta, card = metadata(session, quran.TAFSIR_KEY, "ar", listing)
            rows, null_count, latest, failed = fetch_surahs(session, quran.TAFSIR_KEY, surahs)
            if failed:
                raise SnapshotError(f"{len(failed)} tafsir responses failed; first: {failed[0]}")
            with_notes = [(n, r["aya"]) for n in surahs for r in rows[n] if r["footnotes"] != ""]
            if with_notes:
                raise SnapshotError(f"tafsir rows carry footnotes, first {with_notes[0]}")
        except (FetchError, SnapshotError) as e:
            tafsir_status["omitted"] = str(e)
        else:
            if card:
                cards.append(card)
            tafsir_rows = rows
            tafsir_meta = {
                "key": quran.TAFSIR_KEY,
                "locale": "ar",
                "kind": "tafsir",
                "label": quran.TAFSIR_LABEL,
                "title": meta["title"],
                "description": meta["description"],
                "original_publisher": quran.TAFSIR_PUBLISHER,
                "delivery": "QuranEnc",
                "version": meta["version"],
                "last_update": meta["last_update"],
                "metadata_source": meta["metadata_source"],
                "browse_url": quran.BROWSE_URL.format(key=quran.TAFSIR_KEY),
                "api_template": quran.SURA_URL.replace("{key}", quran.TAFSIR_KEY),
                "retrieved_at": latest,
            }
            arabic_differs = sum(
                1 for n in surahs for r, e in zip(rows[n], texts[quran.EDITION_KEYS[0]][n]) if r["arabic_text"] != e["arabic_text"]
            )
            tafsir_status.update({"delivered": True, "null_footnotes": null_count, "arabic_text_differs_from_editions": arabic_differs})

    notices = [
        f"QuranEnc terms and policies, quoted from {quran.TERMS_URL} (retrieved {terms_item.retrieved_at}): {terms}",
        f"QuranEnc note, quoted from {quran.TERMS_URL}: {note}",
        "All texts are delivered by QuranEnc.com (Encyclopedia of the Noble Quran) and stored as returned by its API: no modification, addition or deletion; each edition keeps its QuranEnc key and version, and footnotes stay attached to their ayah and edition.",
        f"Edition metadata (title, description, version, last_update, direction) is quoted from {quran.LIST_URL} (retrieved {listing_item.retrieved_at}) unless an edition says otherwise below.",
    ]
    for card in cards:
        notices.append(
            f"{card['key']} is not returned by {quran.LIST_URL} or {card['language_url']}; its title and description are read from its catalog card on {quran.CATALOG_URL} (retrieved {session.get(quran.CATALOG_URL).retrieved_at}), and its version from the card header \"{card['date']} - V{card['version']}\", which is the same on {quran.CATALOG_URL} and {quran.CATALOG_AR_URL} (retrieved {session.get(quran.CATALOG_AR_URL).retrieved_at}); "
            + ("its direction is assigned by Balligh and " if card["key"] in quran.EDITION_KEYS else "")
            + "last_update is null."
        )
    if cards:
        catalog = session.get(quran.CATALOG_URL).text()
        agree, differ = [], []
        for e in editions:
            if e["metadata_source"] == quran.CATALOG_URL:
                continue
            try:
                shown = quran.catalog_entry(catalog, e["key"])
            except SnapshotError:
                differ.append(f"{e['key']} (no readable catalog card)")
                continue
            if shown["version"] == e["version"]:
                agree.append(f"{e['key']} {e['version']}")
            else:
                differ.append(f"{e['key']} (catalog V{shown['version']}, API {e['version']})")
        notices.append(
            f"Cross-check of the API versions against the catalog card headers on {quran.CATALOG_URL}: same for "
            + (", ".join(agree) if agree else "none")
            + ("; different for " + ", ".join(differ) if differ else "")
            + "."
        )
    notices.append(
        f"chinese_suliman is listed with language_iso_code \"{listing['chinese_suliman']['language_iso_code']}\"; Balligh maps it to zh-Hans because its text contains {script['simplified_only']} simplified-only and {script['traditional_only']} traditional-only characters from a {len(quran.SIMPLIFIED_ONLY)}-pair check list."
    )
    notices.append(
        "Footnotes returned as null by QuranEnc are stored as \"\": " + ", ".join(f"{key} {nulls[key]}" for key in quran.EDITION_KEYS) + "."
    )
    notices.append(
        f"Every ayah is checked against the standard Hafs per-surah ayah counts (6236 ayahs in total) and QuranEnc's global sequential id; the per-surah counts match the surah list on {quran.NAMES_URL} (retrieved {names_item.retrieved_at}) for all 114 surahs."
    )
    notices.append(
        f"Surah names (name_ar) are the standard Arabic names embedded by Balligh; they match the names on {quran.NAMES_URL} for {114 - len(spelled)} of 114 surahs"
        + ("." if not spelled else "; QuranEnc spells " + ", ".join(f"{n} {names[n][0]} (Balligh: {quran.SURAH_NAMES[n - 1]})" for n in spelled) + ".")
    )
    if kind == "juz_amma":
        notices.append("This snapshot covers Juz' Amma only (surahs 78 to 114, 564 ayahs).")
    if tafsir_meta:
        notices.append(
            f"{quran.TAFSIR_KEY} is {quran.TAFSIR_LABEL}, an Arabic tafsir (not a translation) originally published by the {quran.TAFSIR_PUBLISHER} and delivered here through QuranEnc."
        )
    notices.append("review_status: source_preserved (ingestion checks only; no Balligh human, scholarly or language review).")

    files = quran.build_files(editions, texts, surahs, notices, tafsir_meta, tafsir_rows)
    result = publish(target, files, quran.validate_quran_dir)
    index = json.loads(files["index.json"].decode("utf-8"))
    return {
        "target": str(target),
        "range": result["range"],
        "editions": {
            e["key"]: {
                "locale": e["locale"],
                "version": e["version"],
                "metadata_source": e["metadata_source"],
                "ayahs": e["ayah_count"],
                "footnote_ayahs": e["footnote_ayahs"],
                "null_footnotes": nulls[e["key"]],
            }
            for e in index["editions"]
        },
        "tafsir": {**tafsir_status, **({"ayahs": index["tafsir"][0]["ayah_count"], "version": index["tafsir"][0]["version"]} if index["tafsir"] else {})},
        "quarantine": index["quarantine"],
        "chinese_script": script,
        "files": len(files),
        "index_sha256": bytes_hash(files["index.json"]),
        "snapshot_sha256": content_hash({rel: bytes_hash(data) for rel, data in files.items()}),
        **session.stats(),
    }


def inside_live(path: Path) -> bool:
    return overlaps(path, LIVE)


def main(argv: Optional[list[str]] = None, make_fetcher: Callable[..., Fetcher] = Fetcher) -> int:
    parser = argparse.ArgumentParser(
        description="Import the QuranEnc Quran editions into a staging collection directory; publish it to the live library with refresh_library.py"
    )
    parser.add_argument("--out", type=Path, default=STAGING, help=f"collection directory to publish into (default {STAGING}); must be outside {LIVE}")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--range", dest="kind", choices=sorted(quran.RANGES), default="full")
    parser.add_argument("--tafsir", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args(argv)
    if inside_live(args.out):
        print(f"refusing --out {args.out}: it is, contains or is inside the live library {LIVE}; use refresh_library.py to publish", file=sys.stderr)
        return 2
    fetcher = make_fetcher(CACHE, offline=args.offline)
    try:
        summary = run(fetcher, args.out, args.kind, args.tafsir)
    except (FetchError, SnapshotError) as e:
        failed = {"error": str(e), "published": False, "network_requests": fetcher.network_requests, "failures": fetcher.failures}
        print(json.dumps(failed, ensure_ascii=False, indent=1))
        return 1
    finally:
        fetcher.close()
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
