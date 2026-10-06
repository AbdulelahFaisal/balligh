import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from balligh.library.catalog import CATALOG_FILE, Library, index_pins
from balligh.library.refresh import RefreshAborted, RefreshBusy, contract_requirements, refresh, tree_hash
from test_library_api import build_library, write

SERVER = Path(__file__).resolve().parents[1]
TOOLS = SERVER / "tools" / "library"
APP = SERVER.parent


def check(path: Path) -> dict:
    index = json.loads((path / "index.json").read_bytes().decode("utf-8"))
    if not isinstance(index, dict) or not index.get("schema"):
        raise ValueError(f"{path.name} index is invalid")
    return {"schema": index["schema"]}


def broken(path: Path) -> dict:
    raise ValueError(f"{path.name} failed validation")


VALIDATORS = {"quran": check, "fatwa": check, "hadith": check}


def records(out: Path, name: str, count: int, **extra) -> None:
    shutil.rmtree(out)
    out.mkdir()
    rows = []
    for i in range(1, count + 1):
        rid = f"{'binbaz' if name == 'fatwa' else 'hadeethenc'}-{i}"
        rec = {"id": rid, "title": f"عنوان جديد {i}", "topic": "belief", "source_categories": [], "translations": {}, "source": {"url": f"https://example.org/{i}"}}
        rel = f"records/{rid}.json"
        rows.append({"id": rid, "title": rec["title"], "topic": "belief", "file": rel, "sha256": write(out, rel, rec)})
    write(out, "index.json", {"schema": f"balligh.library.{name}.index/1", "count": len(rows), "records": rows, **extra})


def new_fatwas(out: Path) -> None:
    records(out, "fatwa", 3)


def failing(out: Path) -> None:
    shutil.rmtree(out)
    raise RuntimeError("importer failed after removing its files")


def read_all(root: Path) -> Library:
    library = Library(root)
    assert library.errors == {}
    for number in sorted(library.surah_rows):
        assert library.surah(number, "ar", None)["ayahs"]
    for name in ("fatwa", "hadith"):
        for rid in library.records[name].order:
            assert library.record(name, rid, "ar")["record"]["id"] == rid
    return library


@pytest.fixture
def live(tmp_path: Path) -> Path:
    root = tmp_path / "content" / "library"
    build_library(root)
    return root


def run(live: Path, steps, validators=VALIDATORS, requirements=None):
    base = live.parent.parent
    return refresh(live, base / "work", steps, validators, requirements, base / "refresh.lock")


def assert_untouched(live: Path, before: str) -> None:
    base = live.parent.parent
    assert tree_hash(live) == before
    assert not live.with_name("library.previous").exists()
    assert not (base / "refresh.lock").exists()
    assert list((base / "work").iterdir()) == []
    read_all(live)


def test_failed_later_step_keeps_live_tree_and_catalog(live):
    before = tree_hash(live)
    catalog = (live / CATALOG_FILE).read_bytes()
    with pytest.raises(RefreshAborted, match="importer failed"):
        run(live, {"fatwa": new_fatwas, "hadith": failing})
    assert (live / CATALOG_FILE).read_bytes() == catalog
    assert_untouched(live, before)


def test_validation_failure_keeps_live_tree(live):
    before = tree_hash(live)
    with pytest.raises(RefreshAborted, match="hadith failed validation"):
        run(live, {"fatwa": new_fatwas}, {**VALIDATORS, "hadith": broken})
    assert_untouched(live, before)


def test_promotion_rename_failure_restores_live(live, monkeypatch):
    before = tree_hash(live)
    real = os.replace
    calls = []

    def fake(src, dst):
        calls.append(Path(src).name)
        if Path(src).name.startswith("candidate-"):
            raise OSError("simulated rename failure")
        return real(src, dst)

    monkeypatch.setattr(os, "replace", fake)
    with pytest.raises(RefreshAborted, match="restored"):
        run(live, {"fatwa": new_fatwas})
    monkeypatch.setattr(os, "replace", real)
    assert calls[0] == "library" and calls[1].startswith("candidate-") and calls[2] == "library.previous"
    assert_untouched(live, before)


def test_below_minimum_collection_never_becomes_live(live):
    before = tree_hash(live)

    def minimum(root: Path) -> list[str]:
        index = json.loads((root / "hadith" / "index.json").read_bytes().decode("utf-8"))
        return [] if len(index["records"]) >= 2 and index.get("incomplete") is False else ["hadith-count-complete"]

    with pytest.raises(RefreshAborted, match="contracted corpus"):
        run(live, {"hadith": lambda out: records(out, "hadith", 1, incomplete=True)}, requirements=minimum)
    assert_untouched(live, before)
    with pytest.raises(RefreshAborted, match="quran-full-six-editions"):
        run(live, {"fatwa": new_fatwas}, requirements=contract_requirements)
    assert_untouched(live, before)


def test_contract_requirements_need_the_full_corpus(tmp_path):
    def index(name: str, value: dict) -> None:
        (tmp_path / name).mkdir(exist_ok=True)
        (tmp_path / name / "index.json").write_bytes(json.dumps(value).encode("utf-8"))

    index("quran", {"range": {"kind": "full", "ayah_count": 6236}, "surahs": [{}] * 114, "editions": [{}] * 6})
    index("fatwa", {"records": [{}] * 100})
    index("hadith", {"records": [{}] * 150, "incomplete": False})
    assert contract_requirements(tmp_path) == []
    index("hadith", {"records": [{}] * 150, "incomplete": True})
    index("fatwa", {"records": [{}] * 99})
    index("quran", {"range": {"kind": "juz_amma", "ayah_count": 564}, "surahs": [{}] * 37, "editions": [{}] * 6})
    assert contract_requirements(tmp_path) == ["quran-full-six-editions", "fatwa-count", "hadith-count-complete"]


def test_successful_refresh_promotes_new_version(live):
    quran_before = tree_hash(live / "quran")
    hadith_before = tree_hash(live / "hadith")
    summary = run(live, {"fatwa": new_fatwas})
    assert summary["promoted"] and summary["changed"] == ["fatwa"] and summary["refreshed"] == ["fatwa"]
    assert summary["pins"] == index_pins(live)
    catalog = json.loads((live / CATALOG_FILE).read_bytes().decode("utf-8"))
    assert {k: v["index_sha256"] for k, v in catalog["collections"].items()} == index_pins(live)
    assert catalog["snapshot"] == summary["snapshot"]
    library = read_all(live)
    assert library.records["fatwa"].order == ["binbaz-1", "binbaz-2", "binbaz-3"]
    assert library.record("fatwa", "binbaz-3", "ar")["record"]["title"] == "عنوان جديد 3"
    assert tree_hash(live / "quran") == quran_before and tree_hash(live / "hadith") == hadith_before
    base = live.parent.parent
    assert not live.with_name("library.previous").exists() and not (base / "refresh.lock").exists()
    assert list((base / "work").iterdir()) == []


def test_overlapping_refresh_is_rejected(live):
    before = tree_hash(live)
    lock = live.parent.parent / "refresh.lock"
    lock.write_bytes(b"pid=1 started=earlier\n")
    with pytest.raises(RefreshBusy, match="delete that file"):
        run(live, {"fatwa": new_fatwas})
    assert lock.read_bytes() == b"pid=1 started=earlier\n" and tree_hash(live) == before
    lock.unlink()
    inner = []

    def nested(out: Path) -> None:
        try:
            run(live, {"hadith": failing})
        except RefreshBusy as e:
            inner.append(e)
            raise
        new_fatwas(out)

    with pytest.raises(RefreshAborted):
        run(live, {"fatwa": nested})
    assert len(inner) == 1
    assert_untouched(live, before)


def test_refresh_cli_exits_3_when_the_lock_is_held(live, tmp_path):
    before = tree_hash(live)
    lock = tmp_path / "held.lock"
    lock.write_bytes(b"pid=1\n")
    cmd = [sys.executable, str(TOOLS / "refresh_library.py"), "--root", str(live), "--work", str(tmp_path / "work"), "--lock", str(lock), "--offline", "--collections", "fatwa"]
    proc = subprocess.run(cmd, capture_output=True, cwd=str(tmp_path))
    assert proc.returncode == 3, proc.stdout + proc.stderr
    body = json.loads(proc.stdout.decode("utf-8"))
    assert body["busy"] is True and body["promoted"] is False
    assert lock.exists() and tree_hash(live) == before


LIVE_ALIASES = [APP / "content" / "library", APP / "content" / "library" / "x" / ".." / "quran"]
if os.path.normcase("A") != "A":
    LIVE_ALIASES.append(APP / "content" / "LIBRARY" / "quran")


@pytest.mark.parametrize("out", LIVE_ALIASES)
def test_import_quran_refuses_the_live_library(out, tmp_path):
    proc = subprocess.run([sys.executable, str(TOOLS / "import_quran.py"), "--offline", "--out", str(out)], capture_output=True, cwd=str(tmp_path))
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert b"refusing --out" in proc.stderr


def test_interrupt_between_renames_restores_the_previous_snapshot(live, monkeypatch):
    before = tree_hash(live)
    real = os.replace

    def fake(src, dst):
        if Path(src).name.startswith("candidate-"):
            raise KeyboardInterrupt
        return real(src, dst)

    monkeypatch.setattr(os, "replace", fake)
    with pytest.raises(KeyboardInterrupt) as info:
        run(live, {"fatwa": new_fatwas})
    monkeypatch.setattr(os, "replace", real)
    assert any("restored" in note for note in getattr(info.value, "__notes__", []))
    assert_untouched(live, before)


def test_failed_restore_after_an_interrupt_keeps_the_previous_copy(live, monkeypatch):
    before = tree_hash(live)
    previous = live.with_name("library.previous")
    base = live.parent.parent
    real = os.replace

    def fake(src, dst):
        if Path(src).name.startswith("candidate-"):
            raise KeyboardInterrupt
        if Path(src).name == "library.previous":
            raise OSError("simulated restore failure")
        return real(src, dst)

    monkeypatch.setattr(os, "replace", fake)
    with pytest.raises(KeyboardInterrupt) as info:
        run(live, {"fatwa": new_fatwas})
    monkeypatch.setattr(os, "replace", real)
    assert any(str(previous) in note for note in info.value.__notes__)
    assert not live.exists() and tree_hash(previous) == before
    assert not (base / "refresh.lock").exists() and list((base / "work").iterdir()) == []
    with pytest.raises(RefreshAborted, match="is missing"):
        run(live, {"fatwa": new_fatwas})
    assert not live.exists() and tree_hash(previous) == before
    real(previous, live)
    assert_untouched(live, before)


def test_failed_restore_after_a_rename_error_keeps_the_previous_copy(live, monkeypatch):
    before = tree_hash(live)
    previous = live.with_name("library.previous")
    real = os.replace

    def fake(src, dst):
        if Path(src).name.startswith("candidate-") or Path(src).name == "library.previous":
            raise OSError("simulated rename failure")
        return real(src, dst)

    monkeypatch.setattr(os, "replace", fake)
    with pytest.raises(RefreshAborted, match="could not be restored"):
        run(live, {"fatwa": new_fatwas})
    monkeypatch.setattr(os, "replace", real)
    assert not live.exists() and tree_hash(previous) == before


def interrupt_after_moving_aside(monkeypatch, where, error, restore_fails=False):
    owner, name = (os, "replace") if where == "os.replace" else (sys.modules[refresh.__module__], "_replace")
    real = getattr(owner, name)
    calls = []

    def fake(src, dst):
        calls.append(Path(src).name)
        if restore_fails and Path(src).name == "library.previous":
            raise OSError("simulated restore failure")
        real(src, dst)
        if Path(src).name == "library":
            raise error("simulated stop after the live root was moved aside")

    monkeypatch.setattr(owner, name, fake)
    return calls


@pytest.mark.parametrize("where", ["os.replace", "_replace"])
def test_interrupt_right_after_the_live_root_is_moved_aside_restores_it(live, monkeypatch, where):
    before = tree_hash(live)
    calls = interrupt_after_moving_aside(monkeypatch, where, KeyboardInterrupt)
    with pytest.raises(KeyboardInterrupt) as info:
        run(live, {"fatwa": new_fatwas})
    monkeypatch.undo()
    assert calls == ["library", "library.previous"]
    assert any("restored" in note for note in info.value.__notes__)
    assert_untouched(live, before)


@pytest.mark.parametrize("where", ["os.replace", "_replace"])
def test_rename_error_right_after_the_live_root_is_moved_aside_restores_it(live, monkeypatch, where):
    before = tree_hash(live)
    calls = interrupt_after_moving_aside(monkeypatch, where, OSError)
    with pytest.raises(RefreshAborted, match="previous snapshot was restored"):
        run(live, {"fatwa": new_fatwas})
    monkeypatch.undo()
    assert calls == ["library", "library.previous"]
    assert_untouched(live, before)


@pytest.mark.parametrize("error", [KeyboardInterrupt, OSError])
@pytest.mark.parametrize("where", ["os.replace", "_replace"])
def test_failed_restore_right_after_the_live_root_is_moved_aside_keeps_the_previous_copy(live, monkeypatch, where, error):
    before = tree_hash(live)
    previous = live.with_name("library.previous")
    base = live.parent.parent
    real = os.replace
    interrupt_after_moving_aside(monkeypatch, where, error, restore_fails=True)
    with pytest.raises(KeyboardInterrupt if error is KeyboardInterrupt else RefreshAborted) as info:
        run(live, {"fatwa": new_fatwas})
    monkeypatch.undo()
    text = " ".join([str(info.value), *getattr(info.value, "__notes__", [])])
    assert f"kept at {previous}" in text and f"rename it to {live}" in text
    assert not live.exists() and tree_hash(previous) == before
    assert not (base / "refresh.lock").exists() and list((base / "work").iterdir()) == []
    with pytest.raises(RefreshAborted, match="is missing"):
        run(live, {"fatwa": new_fatwas})
    assert not live.exists() and tree_hash(previous) == before
    real(previous, live)
    assert_untouched(live, before)


def test_live_root_that_cannot_be_moved_aside_is_left_in_place(live, monkeypatch):
    before = tree_hash(live)
    real = os.replace

    def fake(src, dst):
        if Path(src).name == "library":
            raise OSError("simulated rename failure")
        return real(src, dst)

    monkeypatch.setattr(os, "replace", fake)
    with pytest.raises(RefreshAborted, match="could not be moved aside"):
        run(live, {"fatwa": new_fatwas})
    monkeypatch.undo()
    assert_untouched(live, before)


def test_both_snapshots_present_is_reported_and_nothing_is_deleted(live):
    before = tree_hash(live)
    previous = live.with_name("library.previous")
    shutil.copytree(live, previous)
    with pytest.raises(RefreshAborted, match="both"):
        run(live, {"fatwa": new_fatwas})
    assert tree_hash(live) == before and tree_hash(previous) == before
