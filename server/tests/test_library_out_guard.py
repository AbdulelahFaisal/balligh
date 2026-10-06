import importlib.util
import os
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parents[1] / "tools" / "library"
IMPORTERS = ("import_quran", "import_hadeethenc", "import_binbaz")
CASES = ("live", "descendant", "content", "app", "dotdot")


class Boom(Exception):
    pass


def load(name: str):
    spec = importlib.util.spec_from_file_location(f"{name}_guard_under_test", TOOLS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def tree(root: Path) -> dict:
    return {p.relative_to(root).as_posix(): (p.read_bytes() if p.is_file() else None) for p in sorted(root.rglob("*"))}


@pytest.fixture
def app(tmp_path: Path) -> Path:
    root = tmp_path / "app"
    (root / "content" / "library" / "quran").mkdir(parents=True)
    (root / "content" / "library" / "library.json").write_bytes(b"library sentinel")
    (root / "content" / "library" / "quran" / "index.json").write_bytes(b"quran sentinel")
    (root / "content" / "sources").mkdir()
    (root / "content" / "sources" / "manifest.json").write_bytes(b"lesson registry sentinel")
    return root


def outs(root: Path) -> dict:
    live = root / "content" / "library"
    return {
        "live": live,
        "descendant": live / "quran",
        "content": root / "content",
        "app": root,
        "dotdot": live / "quran" / ".." / "x" / "..",
    }


def prepare(name: str, root: Path, monkeypatch):
    module = load(name)
    live = root / "content" / "library"
    cache = root / "var" / "cache"
    calls = []

    def boom(*args, **kwargs):
        calls.append(args)
        raise Boom("the fetcher must not be created")

    if name == "import_quran":
        monkeypatch.setattr(module, "LIVE", live)
        monkeypatch.setattr(module, "CACHE", cache)
        return (lambda out: module.main(["--offline", "--out", str(out)], make_fetcher=boom)), calls
    if name == "import_hadeethenc":
        monkeypatch.setattr(module, "LIVE_DIR", live)
    else:
        monkeypatch.setattr(module, "LIVE_ROOT", live)
    monkeypatch.setattr(module, "CACHE_DIR", cache)
    monkeypatch.setattr(module, "Fetcher", boom)
    return (lambda out: module.main(["--offline", "--out", str(out)])), calls


@pytest.mark.parametrize("name", IMPORTERS)
@pytest.mark.parametrize("case", CASES)
def test_out_overlapping_the_live_library_is_refused_before_any_work(name, case, app, monkeypatch, capsys):
    run, calls = prepare(name, app, monkeypatch)
    before = tree(app)
    assert run(outs(app)[case]) == 2
    assert calls == []
    assert tree(app) == before
    assert (app / "content" / "sources" / "manifest.json").read_bytes() == b"lesson registry sentinel"
    assert not (app / "var").exists()


@pytest.mark.parametrize("name", IMPORTERS)
def test_an_independent_staging_folder_passes_the_guard(name, app, monkeypatch, capsys):
    run, calls = prepare(name, app, monkeypatch)
    from balligh.library.snapshot import overlaps

    sibling = app / "var" / "library-staging" / "collection"
    assert not overlaps(sibling, app / "content" / "library")
    try:
        code = run(sibling)
    except Boom:
        code = None
    assert code != 2 and len(calls) == 1
    assert (app / "content" / "library" / "quran" / "index.json").read_bytes() == b"quran sentinel"


@pytest.mark.skipif(os.path.normcase("A") == "A", reason="case-sensitive path semantics on this platform")
@pytest.mark.parametrize("name", IMPORTERS)
def test_a_case_alias_is_refused_where_paths_ignore_case(name, app, monkeypatch, capsys):
    run, calls = prepare(name, app, monkeypatch)
    before = tree(app)
    assert run(app / "CONTENT" / "Library" / "quran") == 2 and run(app / "Content") == 2
    assert calls == [] and tree(app) == before


def test_a_symlink_alias_is_refused(app, tmp_path, monkeypatch, capsys):
    alias = tmp_path / "alias"
    try:
        os.symlink(app / "content" / "library", alias, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symbolic links cannot be created here")
    for name in IMPORTERS:
        run, calls = prepare(name, app, monkeypatch)
        before = tree(app)
        assert run(alias / "quran") == 2 and calls == [] and tree(app) == before


def test_case_differences_are_distinct_paths_where_the_platform_says_so(tmp_path):
    from balligh.library.snapshot import overlaps

    live = tmp_path / "content" / "library"
    other = tmp_path / "content" / "LIBRARY" / "quran"
    assert overlaps(other, live) is (os.path.normcase("A") != "A")
