from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

from .snapshot import SnapshotError, bytes_hash, file_bytes, read_json, read_verified

SCHEMA = "balligh.quran-audio/1"
READ_ID = 92
RECITER_AR = "ياسر الدوسري"
RECITER_EN = "Yasser Al-Dosari"
REWAYA_AR = "حفص عن عاصم"
FOLDER_URL = "https://cdn.mp3quran.net/audio/yasser-dosari/r1/"
READS_URL = "https://www.mp3quran.net/api/v3/ayat_timing/reads"
SOAR_URL = f"https://www.mp3quran.net/api/v3/ayat_timing/soar?read={READ_ID}"
TIMING_URL = "https://www.mp3quran.net/api/v3/ayat_timing?surah={surah}&read=" + str(READ_ID)
PUBLISHER_URL = "https://www.mp3quran.net/ar/yasser/downloads"
DOCS_URL = "https://www.mp3quran.net/ar/api"
PAGE_URL = re.compile(r"^https://www\.mp3quran\.net/api/quran_pages_svg/(\d{3})\.svg$")
PAGE_COUNT = 604
UNITS = {"raw": "start_time/end_time integers from the publisher", "seconds": "raw / 1000"}
FILES = ("timing.json", "pages.json")


class AudioDataError(SnapshotError):
    pass


def track_url(surah: int) -> str:
    return f"{FOLDER_URL}{surah:03d}.mp3"


def check_pairing(reads: Any) -> dict[str, Any]:
    if not isinstance(reads, list):
        raise AudioDataError("reads endpoint did not return a list")
    matches = [r for r in reads if isinstance(r, dict) and r.get("id") == READ_ID]
    if len(matches) != 1:
        raise AudioDataError(f"read {READ_ID} is not listed exactly once")
    entry = matches[0]
    if entry.get("folder_url") != FOLDER_URL:
        raise AudioDataError(f"read {READ_ID} is paired with {entry.get('folder_url')!r}, not {FOLDER_URL}")
    if entry.get("name") != RECITER_AR or entry.get("rewaya") != REWAYA_AR:
        raise AudioDataError(f"read {READ_ID} reciter identity changed")
    if entry.get("soar_count") != 114:
        raise AudioDataError(f"read {READ_ID} does not list 114 surahs")
    return {k: entry.get(k) for k in ("id", "name", "rewaya", "folder_url", "soar_count", "soar_link")}


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def page_of(value: Any) -> int | None:
    if not isinstance(value, str):
        return None
    m = PAGE_URL.match(value)
    if not m:
        return None
    page = int(m.group(1))
    return page if 1 <= page <= PAGE_COUNT else None


def normalize_surah(surah: int, ayah_count: int, rows: Any) -> dict[str, Any]:
    if not isinstance(rows, list):
        raise AudioDataError(f"surah {surah}: timing is not a list")
    seen: set[int] = set()
    intro = None
    by_ayah: dict[int, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or isinstance(row.get("ayah"), bool) or not isinstance(row.get("ayah"), int):
            raise AudioDataError(f"surah {surah}: malformed timing row")
        ayah = row["ayah"]
        if ayah in seen:
            raise AudioDataError(f"surah {surah}: duplicate ayah {ayah}")
        seen.add(ayah)
        if ayah == 0:
            start, end = _number(row.get("start_time")), _number(row.get("end_time"))
            intro = {"start_ms": start, "end_ms": end} if start is not None and end is not None else None
            continue
        if not 1 <= ayah <= ayah_count:
            raise AudioDataError(f"surah {surah}: ayah {ayah} is outside 1..{ayah_count}")
        by_ayah[ayah] = row
    timed: list[list[Any]] = []
    unavailable: list[dict[str, Any]] = []
    last_end = intro["end_ms"] if intro else 0.0
    for ayah in range(1, ayah_count + 1):
        row = by_ayah.get(ayah)
        if row is None:
            unavailable.append({"ayah": ayah, "page": None, "reason": "no publisher timing row"})
            continue
        page = page_of(row.get("page"))
        start, end = _number(row.get("start_time")), _number(row.get("end_time"))
        reason = None
        if page is None:
            reason = "no valid publisher page reference"
        elif start is None or end is None:
            reason = "non-numeric or non-finite time"
        elif start < 0 or end < 0:
            reason = "negative time"
        elif end <= start:
            reason = "end is not after start"
        elif start < last_end:
            reason = "start precedes the previous ayah end"
        if reason:
            unavailable.append({"ayah": ayah, "page": page, "reason": reason})
            continue
        timed.append([ayah, int(start) if start.is_integer() else start, int(end) if end.is_integer() else end, page])
        last_end = end
    return {
        "surah": surah,
        "track_url": track_url(surah),
        "timing_url": TIMING_URL.format(surah=surah),
        "intro": intro,
        "ayahs": timed,
        "unavailable": unavailable,
    }


def build_pages(surahs: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    pages: dict[int, list[list[int]]] = {}
    for s in surahs:
        for ayah, _start, _end, page in s["ayahs"]:
            pages.setdefault(page, []).append([s["surah"], ayah])
        for u in s["unavailable"]:
            if u.get("page"):
                pages.setdefault(u["page"], []).append([s["surah"], u["ayah"]])
    out = []
    for page in sorted(pages):
        out.append({"page": page, "ayahs": sorted(pages[page])})
    return out


def check_surah(entry: Any, ayah_count: int) -> None:
    if not isinstance(entry, dict):
        raise AudioDataError("surah entry is not an object")
    n = entry.get("surah")
    if entry.get("track_url") != track_url(n) or entry.get("timing_url") != TIMING_URL.format(surah=n):
        raise AudioDataError(f"surah {n}: track or timing url is not the read {READ_ID} pairing")
    seen: set[int] = set()
    last_end = 0.0
    intro = entry.get("intro")
    if intro is not None:
        a, b = _number(intro.get("start_ms")), _number(intro.get("end_ms"))
        if a is None or b is None or a < 0 or b < a:
            raise AudioDataError(f"surah {n}: invalid introduction interval")
        last_end = b
    last_ayah = 0
    for row in entry.get("ayahs", []):
        if not isinstance(row, list) or len(row) != 4:
            raise AudioDataError(f"surah {n}: malformed ayah interval")
        ayah, start, end, page = row
        if not isinstance(ayah, int) or isinstance(ayah, bool) or not 1 <= ayah <= ayah_count:
            raise AudioDataError(f"surah {n}: ayah {ayah!r} is out of range")
        if ayah in seen:
            raise AudioDataError(f"surah {n}: duplicate ayah {ayah}")
        if ayah < last_ayah:
            raise AudioDataError(f"surah {n}: ayahs are not in order")
        seen.add(ayah)
        last_ayah = ayah
        s, e = _number(start), _number(end)
        if s is None or e is None or s < 0 or e <= s or s < last_end:
            raise AudioDataError(f"surah {n}: ayah {ayah} interval is not finite, non-negative and monotonic")
        if not isinstance(page, int) or not 1 <= page <= PAGE_COUNT:
            raise AudioDataError(f"surah {n}: ayah {ayah} page is invalid")
        last_end = e
    for u in entry.get("unavailable", []):
        ayah = u.get("ayah") if isinstance(u, dict) else None
        if not isinstance(ayah, int) or not 1 <= ayah <= ayah_count or ayah in seen:
            raise AudioDataError(f"surah {n}: invalid or duplicate unavailable ayah {ayah!r}")
        if not isinstance(u.get("reason"), str) or not u["reason"]:
            raise AudioDataError(f"surah {n}: unavailable ayah {ayah} has no reason")
        seen.add(ayah)
    if seen != set(range(1, ayah_count + 1)):
        raise AudioDataError(f"surah {n}: coverage does not match the local ayah count {ayah_count}")


@dataclass(frozen=True)
class AudioDataset:
    manifest: dict[str, Any]
    surahs: dict[int, dict[str, Any]]
    pages: list[dict[str, Any]]

    def summary(self) -> dict[str, Any]:
        m = self.manifest
        return {
            "status": "ready",
            "schema": m["schema"],
            "read_id": m["read_id"],
            "reciter": m["reciter"],
            "folder_url": m["folder_url"],
            "sources": m["sources"],
            "units": m["units"],
            "retrieved_at": m["retrieved_at"],
            "counts": m["counts"],
            "dataset_sha256": m["files"]["timing.json"],
            "pages": [[p["page"], p["ayahs"]] for p in self.pages],
        }


def validate_dataset(base: Path, ayah_counts: Mapping[int, int]) -> AudioDataset:
    base = Path(base)
    manifest = read_json(base, "manifest.json")
    if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA:
        raise AudioDataError("unknown quran audio schema")
    if manifest.get("read_id") != READ_ID or manifest.get("folder_url") != FOLDER_URL:
        raise AudioDataError("dataset is not the read 92 / yasser-dosari r1 pairing")
    pairing = manifest.get("pairing") or {}
    if pairing.get("id") != READ_ID or pairing.get("folder_url") != FOLDER_URL:
        raise AudioDataError("recorded reads pairing does not match")
    files = manifest.get("files")
    if not isinstance(files, dict) or set(files) != set(FILES):
        raise AudioDataError("manifest file list is wrong")
    timing = read_verified(base, "timing.json", files["timing.json"])
    pages = read_verified(base, "pages.json", files["pages.json"])
    surahs = timing.get("surahs") if isinstance(timing, dict) else None
    if not isinstance(surahs, list) or [s.get("surah") for s in surahs if isinstance(s, dict)] != list(range(1, 115)):
        raise AudioDataError("timing must list surahs 1..114 in order")
    if set(ayah_counts) != set(range(1, 115)):
        raise AudioDataError("local Quran ayah counts are incomplete")
    for entry in surahs:
        check_surah(entry, ayah_counts[entry["surah"]])
    rebuilt = build_pages(surahs)
    if not isinstance(pages, dict) or pages.get("pages") != rebuilt:
        raise AudioDataError("page map does not match the timing page references")
    if [p["page"] for p in rebuilt] != list(range(1, PAGE_COUNT + 1)):
        raise AudioDataError("page map does not cover pages 1..604")
    order = [(s["surah"], a[0], a[3]) for s in surahs for a in s["ayahs"]]
    if any(order[i][2] > order[i + 1][2] for i in range(len(order) - 1)):
        raise AudioDataError("publisher pages are not monotonic in Quran order")
    return AudioDataset(manifest=manifest, surahs={s["surah"]: s for s in surahs}, pages=rebuilt)


def dataset_files(manifest_base: Mapping[str, Any], surahs: list[dict[str, Any]]) -> dict[str, bytes]:
    timing = file_bytes({"schema": SCHEMA, "surahs": surahs})
    pages = file_bytes({"pages": build_pages(surahs)})
    manifest = dict(manifest_base)
    manifest["files"] = {"timing.json": bytes_hash(timing), "pages.json": bytes_hash(pages)}
    return {"manifest.json": file_bytes(manifest), "timing.json": timing, "pages.json": pages}


def local_ayah_counts(quran_dir: Path) -> dict[int, int]:
    index = read_json(Path(quran_dir), "index.json")
    return {int(s["number"]): int(s["ayah_count"]) for s in index["surahs"]}
