from __future__ import annotations

import threading
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException

from .library.quran_audio import AudioDataset, local_ayah_counts, validate_dataset
from .library.snapshot import SnapshotError

LIBRARY_ROOT = Path(__file__).resolve().parents[2] / "content" / "library"

router = APIRouter(prefix="/api")


class _State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.root = LIBRARY_ROOT
        self.loaded = False
        self.dataset: Optional[AudioDataset] = None
        self.error: Optional[str] = None

    def configure(self, root: Path) -> None:
        with self.lock:
            self.root = Path(root)
            self.loaded = False
            self.dataset = None
            self.error = None

    def get(self) -> AudioDataset:
        with self.lock:
            if not self.loaded:
                try:
                    counts = local_ayah_counts(self.root / "quran")
                    self.dataset = validate_dataset(self.root / "quran-audio", counts)
                except (SnapshotError, KeyError, TypeError, ValueError, AttributeError) as e:
                    self.dataset = None
                    self.error = type(e).__name__
                self.loaded = True
            if self.dataset is None:
                raise HTTPException(status_code=503, detail={"status": "unavailable", "reason": "recorded recitation metadata failed validation"})
            return self.dataset


state = _State()


@router.get("/library/quran-audio")
def quran_audio_summary() -> dict:
    return state.get().summary()


@router.get("/library/quran-audio/{surah}")
def quran_audio_surah(surah: int) -> dict:
    dataset = state.get()
    entry = dataset.surahs.get(surah)
    if entry is None:
        raise HTTPException(status_code=404, detail={"status": "not_found"})
    return {"status": "ready", "read_id": dataset.manifest["read_id"], "units": dataset.manifest["units"], **entry}
