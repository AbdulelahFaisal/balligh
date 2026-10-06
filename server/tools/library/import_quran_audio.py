import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(APP_ROOT / "server"))

from balligh.library import quran_audio as qa
from balligh.library.fetch import FetchError, Fetcher
from balligh.library.snapshot import SnapshotError, publish

LIVE = APP_ROOT / "content" / "library" / "quran-audio"
QURAN = APP_ROOT / "content" / "library" / "quran"
STAGING = APP_ROOT / "var" / "library-staging" / "quran-audio"
CACHE = APP_ROOT / "var" / "library-cache" / "quran-audio"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--cache", type=Path, default=CACHE)
    args = parser.parse_args()
    counts = qa.local_ayah_counts(QURAN)
    fetcher = Fetcher(args.cache, offline=args.offline)
    try:
        reads = fetcher.get(qa.READS_URL)
        pairing = qa.check_pairing(reads.json())
        soar = fetcher.get(qa.SOAR_URL)
        listed = soar.json()
        if [s.get("id") for s in listed] != list(range(1, 115)):
            raise qa.AudioDataError("soar catalog does not list surahs 1..114")
        for s in listed:
            if s.get("timing_link") != qa.TIMING_URL.format(surah=s["id"]):
                raise qa.AudioDataError(f"unexpected timing link for surah {s['id']}")
        with ThreadPoolExecutor(max_workers=2) as pool:
            fetched = list(pool.map(lambda n: fetcher.get(qa.TIMING_URL.format(surah=n)), range(1, 115)))
    except (FetchError, ValueError, qa.AudioDataError) as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 2
    finally:
        fetcher.close()
    surahs = [qa.normalize_surah(n, counts[n], item.json()) for n, item in zip(range(1, 115), fetched)]
    sources = {
        "documentation": qa.DOCS_URL,
        "publisher_page": qa.PUBLISHER_URL,
        "reads": {"url": qa.READS_URL, "sha256": reads.sha256, "retrieved_at": reads.retrieved_at},
        "soar": {"url": qa.SOAR_URL, "sha256": soar.sha256, "retrieved_at": soar.retrieved_at},
        "timing": [{"surah": n, "sha256": f.sha256, "retrieved_at": f.retrieved_at} for n, f in zip(range(1, 115), fetched)],
    }
    unavailable = [{"surah": s["surah"], **u} for s in surahs for u in s["unavailable"]]
    manifest = {
        "schema": qa.SCHEMA,
        "read_id": qa.READ_ID,
        "folder_url": qa.FOLDER_URL,
        "pairing": pairing,
        "reciter": {"name_ar": qa.RECITER_AR, "name_en": qa.RECITER_EN, "rewaya_ar": qa.REWAYA_AR, "rewaya_en": "Hafs from Asim"},
        "units": qa.UNITS,
        "retrieved_at": max(f.retrieved_at for f in fetched),
        "sources": sources,
        "counts": {
            "surahs": len(surahs),
            "timed_ayahs": sum(len(s["ayahs"]) for s in surahs),
            "unavailable_ayahs": len(unavailable),
            "introductions": sum(1 for s in surahs if s["intro"]),
            "pages": len(qa.build_pages(surahs)),
        },
        "unavailable": unavailable,
        "audio_hosted": False,
    }
    files = qa.dataset_files(manifest, surahs)
    target = LIVE if args.publish else STAGING
    try:
        dataset = publish(target, files, lambda staging: qa.validate_dataset(staging, counts))
    except SnapshotError as e:
        print(json.dumps({"ok": False, "error": str(e), "counts": manifest["counts"], "unavailable": unavailable[:20]}, ensure_ascii=False))
        return 3
    print(json.dumps({"ok": True, "target": str(target), "counts": manifest["counts"], "network_requests": fetcher.network_requests, "unavailable": unavailable[:20]}, ensure_ascii=False))
    return 0 if dataset else 1


if __name__ == "__main__":
    raise SystemExit(main())
