import argparse
import json
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parents[2]
ROOT = SERVER.parent / "content" / "library"


def validators():
    from balligh.library.fatwa import validate_fatwa_dir
    from balligh.library.hadith import validate_hadith_dir
    from balligh.library.quran import validate_quran_dir

    return {"quran": validate_quran_dir, "fatwa": validate_fatwa_dir, "hadith": validate_hadith_dir}


def coverage(root: Path, library) -> dict:
    from collections import Counter

    summary = library.summary()["collections"]
    out: dict = {"snapshot": library.catalog.get("snapshot"), "requirements": [], "incomplete": []}
    q = json.loads((root / "quran" / "index.json").read_text(encoding="utf-8"))
    rng = q.get("range", {})
    juz_amma = set(range(78, 115))
    delivered = {s["number"] for s in q.get("surahs", [])}
    out["quran"] = {
        "range": rng,
        "arabic_ayahs": sum(s.get("ayah_count", 0) for s in q.get("surahs", [])),
        "editions": {
            e.get("locale"): {k: e.get(k) for k in ("key", "title", "version", "ayah_count", "footnote_ayahs", "metadata_source")}
            for e in q.get("editions", [])
        },
        "tafsir": [{k: t.get(k) for k in ("key", "title", "ayah_count")} for t in q.get("tafsir", [])],
        "quarantine": q.get("quarantine", []),
        "locales": summary["quran"].get("locales"),
    }
    out["requirements"].append({"id": "quran-juz-amma-minimum", "met": juz_amma <= delivered and len(q.get("editions", [])) == 6})
    out["requirements"].append({"id": "quran-full-preferred", "met": len(delivered) == 114 and rng.get("ayah_count") == 6236})
    for name, minimum, maximum in (("fatwa", 100, None), ("hadith", 100, 200)):
        index = json.loads((root / name / "index.json").read_text(encoding="utf-8"))
        records = library._all(name)
        info = {
            "count": len(records),
            "unique_ids": len({r["id"] for r in records.values()}),
            "topics": dict(Counter(r.get("topic") for r in records.values())),
            "locales": summary[name].get("locales"),
            "exclusions": len(index.get("exclusions", [])),
            "exclusion_reasons": dict(Counter(str(x.get("reason", ""))[:80] for x in index.get("exclusions", []))),
        }
        if name == "hadith":
            foreign = ("en", "ur", "zh-Hans", "id", "bn", "fr")
            info["full_seven_language_records"] = sum(
                1 for r in records.values() if all(loc in (r.get("translations") or {}) for loc in foreign)
            )
            info["grades"] = dict(Counter(r.get("grade") for r in records.values()))
            info["grading_authorities"] = dict(Counter(r.get("grading_authority") for r in records.values()))
            info["dorar"] = dict(Counter((r.get("dorar") or {}).get("status") for r in records.values()))
        out[name] = info
        met = len(records) >= minimum and (maximum is None or len(records) <= maximum)
        out["requirements"].append({"id": f"{name}-count", "met": met, "minimum": minimum, "maximum": maximum})
    out["requirements"].append(
        {"id": "hadith-dorar-grading", "met": out["hadith"]["dorar"].get("verified", 0) >= 100}
    )
    out["incomplete"] = [r["id"] for r in out["requirements"] if not r["met"]]
    return out


def main() -> int:
    sys.path.insert(0, str(SERVER))
    from balligh.library.catalog import Library
    from balligh.library.refresh import write_catalog
    from balligh.library.snapshot import SnapshotError, file_bytes

    parser = argparse.ArgumentParser(description="Verify the published library; refresh content with refresh_library.py")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument(
        "--write-catalog",
        action="store_true",
        help="rewrite library.json pins from the current indexes; only for repairing the pins of a stopped server, refused unless every collection validator passes",
    )
    parser.add_argument("--coverage", type=Path)
    args = parser.parse_args()
    root = args.root
    report: dict = {"root": str(root), "collections": {}}
    ok = True
    for name, validate in validators().items():
        try:
            report["collections"][name] = {"valid": True, "summary": validate(root / name)}
        except (SnapshotError, OSError, ValueError, KeyError) as e:
            ok = False
            report["collections"][name] = {"valid": False, "error": f"{type(e).__name__}: {e}"}
    if args.write_catalog:
        if ok:
            write_catalog(root)
        report["catalog_written"] = ok
    library = Library(root)
    report["catalog_errors"] = library.errors
    if library.errors:
        ok = False
    else:
        report["snapshot"] = library.catalog.get("snapshot")
        for name in ("fatwa", "hadith"):
            library.listing(name, topic=None, q=None, locale="ar", page=1, page_size=1)
        for number in sorted(library.surah_rows):
            library.surah(number, "ar", None)
        if args.coverage:
            args.coverage.write_bytes(file_bytes(coverage(root, library)))
    report["ok"] = ok
    print(json.dumps(report, ensure_ascii=False, indent=1, default=str))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
