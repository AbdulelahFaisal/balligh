from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

from .catalog import CATALOG_FILE, CATALOG_SCHEMA, COLLECTIONS, Library, index_pins
from .snapshot import _replace, bytes_hash, content_hash, file_bytes

QURAN_AYAHS = 6236
QURAN_EDITIONS = 6
FATWA_COUNT = 100
HADITH_RANGE = (100, 200)


class RefreshBusy(Exception):
    pass


class RefreshAborted(Exception):
    pass


def _index(root: Path, name: str) -> dict[str, Any]:
    value = json.loads((root / name / "index.json").read_bytes().decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{name} index is not an object")
    return value


def catalog_document(root: Path) -> dict[str, Any]:
    pins = index_pins(root)
    collections: dict[str, Any] = {}
    for name in COLLECTIONS:
        index = _index(root, name)
        if name == "quran":
            info = {"range": index.get("range"), "editions": [e.get("key") for e in index.get("editions", [])]}
        else:
            info = {"count": len(index.get("records", []))}
        collections[name] = {"index_sha256": pins[name], **info}
    return {
        "schema": CATALOG_SCHEMA,
        "snapshot": {"id": content_hash(pins), "collections": list(COLLECTIONS)},
        "collections": collections,
    }


def write_catalog(root: Path) -> dict[str, Any]:
    catalog = catalog_document(root)
    (Path(root) / CATALOG_FILE).write_bytes(file_bytes(catalog))
    return catalog


def contract_requirements(root: Path) -> list[str]:
    unmet: list[str] = []
    quran = _index(root, "quran")
    rng = quran.get("range") or {}
    if not (
        rng.get("kind") == "full"
        and rng.get("ayah_count") == QURAN_AYAHS
        and len(quran.get("surahs") or []) == 114
        and len(quran.get("editions") or []) == QURAN_EDITIONS
    ):
        unmet.append("quran-full-six-editions")
    if len(_index(root, "fatwa").get("records") or []) != FATWA_COUNT:
        unmet.append("fatwa-count")
    hadith = _index(root, "hadith")
    if not (HADITH_RANGE[0] <= len(hadith.get("records") or []) <= HADITH_RANGE[1]) or hadith.get("incomplete") is not False:
        unmet.append("hadith-count-complete")
    return unmet


def tree_hash(root: Path) -> str:
    root = Path(root)
    files = {p.relative_to(root).as_posix(): bytes_hash(p.read_bytes()) for p in sorted(root.rglob("*")) if p.is_file()}
    return content_hash(files)


def _acquire(lock_path: Path) -> None:
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        try:
            holder = lock_path.read_bytes().decode("utf-8", "replace").strip()
        except OSError:
            holder = "unreadable"
        raise RefreshBusy(
            f"another library refresh holds {lock_path} ({holder}); if no refresh is running, delete that file and retry"
        ) from None
    try:
        os.write(fd, f"pid={os.getpid()} started={time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n".encode("utf-8"))
    finally:
        os.close(fd)


def _old_pins(live: Path) -> dict[str, Optional[str]]:
    out: dict[str, Optional[str]] = {}
    for name in COLLECTIONS:
        path = live / name / "index.json"
        out[name] = bytes_hash(path.read_bytes()) if path.is_file() else None
    return out


def _check_library(root: Path) -> None:
    library = Library(root)
    if library.errors:
        raise RefreshAborted(f"the candidate library does not load: {library.errors}")
    for number in sorted(library.surah_rows):
        library.surah(number, "ar", None)
    for name in COLLECTIONS:
        if name != "quran":
            library._all(name)


def _promote(candidate: Path, live: Path, previous: Path) -> None:
    stage = "aside"
    try:
        if live.exists():
            _replace(live, previous)
        stage = "swap"
        _replace(candidate, live)
    except BaseException as e:
        if previous.exists() and not live.exists():
            try:
                _replace(previous, live)
            except BaseException as r:
                note = (
                    f"the previous snapshot could not be restored ({type(r).__name__}) and is kept at {previous}; "
                    f"with no server or refresh running, rename it to {live}"
                )
                if isinstance(e, Exception):
                    raise RefreshAborted(f"promotion failed ({type(e).__name__}: {e}); {note}") from e
                e.add_note(note)
                raise e from r
            if isinstance(e, Exception):
                raise RefreshAborted(f"promotion failed and the previous snapshot was restored: {type(e).__name__}: {e}") from e
            e.add_note(f"promotion was interrupted and the previous snapshot was restored at {live}")
            raise
        if live.exists() and not candidate.exists():
            state = f"{live} already holds the new snapshot" + (f" and {previous} the earlier one" if previous.exists() else "")
        elif stage == "aside":
            state = f"the live snapshot was not moved aside and {live} is unchanged"
        else:
            state = f"the new snapshot was not moved to {live}"
        if isinstance(e, Exception):
            if stage == "aside":
                raise RefreshAborted(f"the live snapshot could not be moved aside: {type(e).__name__}: {e}") from e
            raise RefreshAborted(f"promotion failed ({type(e).__name__}: {e}); {state}") from e
        e.add_note(f"promotion was interrupted; {state}")
        raise
    shutil.rmtree(previous, ignore_errors=True)


def refresh(
    live_root: Path,
    work_dir: Path,
    steps: Mapping[str, Callable[[Path], None]],
    validators: Mapping[str, Callable[[Path], Any]],
    requirements: Optional[Callable[[Path], list[str]]],
    lock_path: Path,
) -> dict[str, Any]:
    live = Path(live_root)
    work = Path(work_dir)
    previous = live.with_name(live.name + ".previous")
    _acquire(Path(lock_path))
    candidate: Optional[Path] = None
    try:
        unknown = sorted(set(steps) - set(COLLECTIONS))
        missing = [name for name in COLLECTIONS if name not in validators]
        if unknown or missing:
            raise RefreshAborted(f"unknown steps {unknown} or missing validators {missing}")
        if previous.exists() and not live.exists():
            raise RefreshAborted(
                f"the live library {live} is missing and {previous} holds the last complete snapshot from an interrupted "
                f"promotion; with no server or refresh running, rename {previous} to {live}, check it with "
                f"verify_library.py, then refresh again (nothing was changed or deleted)"
            )
        if previous.exists():
            raise RefreshAborted(
                f"both {live} and {previous} exist: an earlier promotion stopped after the swap or during cleanup, so "
                f"{previous} is the snapshot from before that promotion and may be incomplete; check {live} with "
                f"verify_library.py and, if it is valid, remove {previous} yourself, otherwise rename it back "
                f"(nothing was changed or deleted)"
            )
        try:
            work.mkdir(parents=True, exist_ok=True)
            candidate = work / f"candidate-{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}-{time.time_ns() % 1000000000:09d}"
            if live.exists():
                shutil.copytree(live, candidate, ignore=lambda d, names: [CATALOG_FILE] if Path(d) == live else [])
            else:
                candidate.mkdir()
            before = _old_pins(live)
            for name in COLLECTIONS:
                if name in steps:
                    (candidate / name).mkdir(exist_ok=True)
                    steps[name](candidate / name)
            validated = {name: validators[name](candidate / name) for name in COLLECTIONS}
            unmet = requirements(candidate) if requirements else []
            if unmet:
                raise RefreshAborted(f"the candidate does not meet the contracted corpus: {unmet}")
            catalog = write_catalog(candidate)
            _check_library(candidate)
        except RefreshAborted:
            raise
        except Exception as e:
            raise RefreshAborted(f"{type(e).__name__}: {e}") from e
        _promote(candidate, live, previous)
        candidate = None
        pins = {name: catalog["collections"][name]["index_sha256"] for name in COLLECTIONS}
        return {
            "promoted": True,
            "root": str(live),
            "refreshed": [name for name in COLLECTIONS if name in steps],
            "changed": [name for name in COLLECTIONS if pins[name] != before[name]],
            "pins": pins,
            "snapshot": catalog["snapshot"],
            "validated": validated,
        }
    finally:
        try:
            if candidate is not None and candidate.exists():
                shutil.rmtree(candidate, ignore_errors=True)
        finally:
            try:
                os.unlink(lock_path)
            except FileNotFoundError:
                pass
