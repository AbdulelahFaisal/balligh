import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from balligh.library.adapter import (
    ADAPTER_SCHEMA,
    ADAPTER_VERSION,
    HONORIFICS,
    REPRESENTATION,
    build_unit,
    manifest_path,
)
from balligh.library.catalog import Library

APP = Path(__file__).resolve().parents[3]
LIBRARY = APP / "content" / "library"
REGISTER = APP / "server" / "tools" / "library" / "data" / "DORAR_CROSSCHECK_REGISTER.json"
MATCHED = "wording_and_attribution_correspond"

SELECTED = [
    ("fatwa", "binbaz-18975", "Complete question and answer (no notes); defines each testimony with a cited ayah; audience review: strong_beginner, reason supported."),
    ("fatwa", "binbaz-3982", "Complete question and answer (no notes); states the minimum (obligations, avoiding prohibitions) and the three ranks; audience review: strong_beginner."),
    ("fatwa", "binbaz-2774", "Complete question and answer (no notes); gives the ruling with the quoted prophetic statement and event; audience review: strong_beginner."),
    ("hadith", "hadeethenc-10101", "Coordinator Dorar comparison: wording and attribution correspond; complete short Prophetic text with narrator preamble."),
    ("hadith", "hadeethenc-5351", "Coordinator Dorar comparison: wording and attribution correspond; complete short Prophetic text with narrator preamble."),
    ("hadith", "hadeethenc-65000", "Coordinator Dorar comparison: wording and attribution correspond; complete Prophetic text (five pillars) with narrator preamble."),
]

REJECTED = [
    ("fatwa", "binbaz-3521", "The complete page contains an elided follow-up question ('السؤال: ...؟') whose answer refers to an unnamed weak hadith; the unit cannot carry its own context and excerpting is not allowed."),
    ("fatwa", "binbaz-10220", "Fits completely (30 words) but the answer is one repetitive sentence; too thin to plausibly support three cards and a question."),
    ("hadith", "hadeethenc-4319", "Dorar comparison found a qualified wording variant (الذبحة/الذبح, وليرح/فليرح); not verification of this record."),
    ("hadith", "hadeethenc-5866", "Wording corresponds but the reference differs (Muslim 1732 vs 1734); kept out until resolved."),
    ("hadith", "hadeethenc-66521", "Corresponds to an al-Albani record that Dorar marks بنحوه; attribution to Muslim's exact wording stays qualified."),
    ("quran", "*", "Quran text is never eligible for generic lesson generation."),
    ("quran_translation", "*", "Quran translations are never eligible for generic lesson generation."),
    ("book", "*", "Books (including the English book) are never eligible for generic lesson generation."),
]


def dorar_rows() -> dict[str, dict]:
    data = json.loads(REGISTER.read_text(encoding="utf-8"))
    return {r["id"]: r for r in data["records"]}


def build() -> dict:
    library = Library(LIBRARY)
    register = dorar_rows()
    units = []
    for collection, record_id, reason in SELECTED:
        unit, rec, _ = build_unit(library, collection, record_id)
        if collection == "hadith":
            row = register.get(record_id)
            if row is None or row.get("status") != MATCHED:
                raise SystemExit(f"{record_id}: not individually matched in the Dorar register")
            if "sha256:" + row["hadeethenc_file_sha256"] != unit["file_sha256"]:
                raise SystemExit(f"{record_id}: register file hash differs from the library pin")
            if row["hadeethenc_content_sha256"] != unit["record_content_sha256"]:
                raise SystemExit(f"{record_id}: register content hash differs from the library record")
            unit["external_check"] = (
                f"Coordinator comparison {row.get('checked_date') or '2026-10-06'}: Prophetic wording and companion "
                f"attribution correspond to {row['dorar_url']}. Source comparison only, not a human scholarly review."
            )
        unit["selection_reason"] = reason
        units.append(unit)
    return {
        "schema": ADAPTER_SCHEMA,
        "adapter_version": ADAPTER_VERSION,
        "representation": REPRESENTATION,
        "honorific_map": {f"U+{ord(k):04X}": v for k, v in sorted(HONORIFICS.items())},
        "units": units,
        "rejected": [{"collection": c, "record_id": r, "reason": why} for c, r, why in REJECTED],
    }


def encode(manifest: dict) -> bytes:
    return (json.dumps(manifest, ensure_ascii=False, indent=1, sort_keys=True) + "\n").encode("utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build or check the pinned lesson adapter manifest (offline).")
    parser.add_argument("--check", action="store_true", help="fail if the manifest differs from a fresh build")
    args = parser.parse_args()
    manifest = build()
    data = encode(manifest)
    path = manifest_path(LIBRARY)
    if args.check:
        current = path.read_bytes() if path.is_file() else b""
        if current != data:
            raise SystemExit("lesson adapter manifest is out of date")
        print("lesson adapter manifest matches a fresh build")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    print(f"wrote {path.relative_to(APP).as_posix()} with {len(manifest['units'])} units")


if __name__ == "__main__":
    main()
