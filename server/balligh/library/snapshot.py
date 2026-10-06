from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
import unicodedata
from pathlib import Path
from typing import Any, Callable, Mapping

SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
REPLACE_ATTEMPTS = 40
REPLACE_PAUSE_S = 0.25


class SnapshotError(Exception):
    pass


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def content_hash(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def file_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=1) + "\n").encode("utf-8")


def bytes_hash(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def path_key(path: Path) -> str:
    return os.path.normcase(os.path.realpath(path)).rstrip("\\/")


def overlaps(path: Path, protected: Path) -> bool:
    a, b = path_key(path), path_key(protected)
    return a == b or a.startswith(b + os.sep) or b.startswith(a + os.sep)


def safe_relative(base: Path, rel: str) -> Path:
    if not isinstance(rel, str) or not rel or rel.startswith(("/", "\\")) or "\\" in rel or ":" in rel:
        raise SnapshotError(f"unsafe path {rel!r}")
    parts = rel.split("/")
    if any(not SAFE_NAME.match(p) or p in (".", "..") for p in parts):
        raise SnapshotError(f"unsafe path {rel!r}")
    resolved_base = base.resolve()
    target = (resolved_base / rel).resolve()
    if resolved_base not in target.parents:
        raise SnapshotError(f"path escapes the collection: {rel!r}")
    return target


def read_json(base: Path, rel: str) -> Any:
    path = safe_relative(base, rel)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise SnapshotError(f"cannot read {rel}: {type(e).__name__}") from None


def read_verified(base: Path, rel: str, expected: str) -> Any:
    path = safe_relative(base, rel)
    try:
        data = path.read_bytes()
    except OSError as e:
        raise SnapshotError(f"cannot read {rel}: {type(e).__name__}") from None
    if bytes_hash(data) != expected:
        raise SnapshotError(f"file hash mismatch for {rel}")
    try:
        return json.loads(data.decode("utf-8"))
    except ValueError:
        raise SnapshotError(f"{rel} is not valid UTF-8 JSON") from None


def publish(target: Path, files: Mapping[str, bytes], validate: Callable[[Path], Any]) -> Any:
    target = Path(target)
    staging = target.with_name(target.name + ".staging")
    previous = target.with_name(target.name + ".previous")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    try:
        for rel, data in files.items():
            path = safe_relative(staging, rel)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        result = validate(staging)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    if previous.exists():
        shutil.rmtree(previous)
    try:
        if target.exists():
            _replace(target, previous)
        try:
            _replace(staging, target)
        except OSError:
            if previous.exists() and not target.exists():
                _replace(previous, target)
            raise
    except OSError:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    if previous.exists():
        shutil.rmtree(previous, ignore_errors=True)
    return result


def _replace(source: Path, destination: Path) -> None:
    for attempt in range(REPLACE_ATTEMPTS):
        try:
            os.replace(source, destination)
            return
        except PermissionError:
            if attempt + 1 == REPLACE_ATTEMPTS:
                raise
            time.sleep(REPLACE_PAUSE_S)


ARABIC_MARKS = re.compile(r"[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]")
ALEF_FORMS = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي"})


def search_key(text: str) -> str:
    folded = unicodedata.normalize("NFKC", text or "")
    folded = ARABIC_MARKS.sub("", folded).translate(ALEF_FORMS)
    return " ".join(folded.casefold().split())
