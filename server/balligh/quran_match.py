"""Known-ayah matching for teacher-supplied text.

A heuristic, not a detector of every quotation: both sides are reduced to bare Arabic letters (diacritics,
Quranic marks and letter variants removed) and a stored ayah is reported when its whole text appears in the
pasted text. Uthmani spellings that differ from ordinary spelling, partial quotations and paraphrases are missed.
"""
import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

_MARKS = re.compile("[ؐ-ًؚ-ٰٟۖ-ۭـ]")
_LETTERS = str.maketrans({"ٱ": "ا", "أ": "ا", "إ": "ا", "آ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي"})
_NON_LETTER = re.compile("[^ء-ي ]+")
_MARKERS = re.compile("[﴾﴿]|قال\\s+(?:الله\\s+)?تعالى|\\[[^\\]\\n]{2,30}:\\s*[0-9٠-٩]{1,3}\\]")
MIN_AYAH_LETTERS = 8
SKIP = {(1, 1)}  # the basmala opens many texts as a formula; it is not reported


def normalize(text: str) -> str:
    bare = _NON_LETTER.sub(" ", _MARKS.sub("", text).translate(_LETTERS))
    return " ".join(bare.split())


def skeleton(text: str) -> str:
    """Normalized text without alef, so Uthmani dagger-alef spellings meet ordinary spelling."""
    return " ".join(w for w in normalize(text).replace("ا", "").split() if w)


@lru_cache(maxsize=2)
def _ayahs(surah_dir: str) -> tuple[tuple[int, int, str], ...]:
    out: list[tuple[int, int, str]] = []
    for path in sorted(Path(surah_dir).glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for ayah in data.get("ayahs", []):
            bare = skeleton(ayah.get("arabic", ""))
            key = (int(path.stem), int(ayah["aya"]))
            if len(bare.replace(" ", "")) >= MIN_AYAH_LETTERS and key not in SKIP:
                out.append((key[0], key[1], bare))
    return tuple(out)


def find_quran(text: str, surah_dir: Path, limit: int = 20) -> dict[str, Any]:
    padded = f" {skeleton(text)} "
    matches = []
    try:
        ayahs = _ayahs(str(surah_dir))
    except (OSError, ValueError, KeyError):
        ayahs = ()
    for surah, aya, bare in ayahs:
        if f" {bare} " in padded:
            matches.append({"surah": surah, "ayah": aya})
            if len(matches) >= limit:
                break
    return {"matches": matches, "markers": len(_MARKERS.findall(text)), "checked": bool(ayahs)}
