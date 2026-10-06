import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
APP_ROOT = TOOLS.parents[2]
sys.path.insert(0, str(APP_ROOT / "server"))
sys.path.insert(0, str(TOOLS))

from balligh.library.catalog import COLLECTIONS, Library
from balligh.library.refresh import RefreshAborted, RefreshBusy, contract_requirements, refresh
from balligh.library.snapshot import file_bytes
from verify_library import coverage, validators

ROOT = APP_ROOT / "content" / "library"
WORK = APP_ROOT / "var" / "library-candidate"
LOCK = APP_ROOT / "var" / "library-refresh.lock"
IMPORTERS = {
    "quran": ("import_quran.py", ["--range", "full"]),
    "fatwa": ("import_binbaz.py", []),
    "hadith": ("import_hadeethenc.py", []),
}


def importer_step(name: str, offline: bool):
    script, extra = IMPORTERS[name]

    def run(out: Path) -> None:
        cmd = [sys.executable, str(TOOLS / script), "--out", str(out), *extra] + (["--offline"] if offline else [])
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        if proc.returncode != 0:
            tail = proc.stdout.decode("utf-8", "replace")[-1500:]
            raise RefreshAborted(f"{script} exited {proc.returncode}: {tail}")

    return run


def inside(path: Path, base: Path) -> bool:
    p = os.path.normcase(str(path.resolve()))
    b = os.path.normcase(str(base.resolve()))
    return p == b or p.startswith(b.rstrip(os.sep) + os.sep)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Refresh the published library as one transaction: import into a candidate copy, validate all collections and the contracted corpus, then promote it atomically (exit 0 promoted; 1 aborted: the live library is restored when possible, otherwise the error names the retained library.previous; 2 invalid arguments; 3 another refresh holds the lock)"
    )
    parser.add_argument("--collections", default=",".join(COLLECTIONS))
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--work", type=Path, default=WORK)
    parser.add_argument("--lock", type=Path, default=LOCK)
    parser.add_argument("--coverage", type=Path)
    args = parser.parse_args(argv)
    names = [n.strip() for n in args.collections.split(",") if n.strip()]
    if not names or any(n not in COLLECTIONS for n in names):
        parser.error(f"--collections must name some of {', '.join(COLLECTIONS)}")
    if inside(args.work, args.root) or inside(args.root, args.work):
        parser.error("--work and --root must not contain each other")
    steps = {n: importer_step(n, args.offline) for n in names}
    try:
        summary = refresh(args.root, args.work, steps, validators(), contract_requirements, args.lock)
    except RefreshBusy as e:
        print(json.dumps({"promoted": False, "busy": True, "error": str(e)}, ensure_ascii=False, indent=1))
        return 3
    except RefreshAborted as e:
        print(json.dumps({"promoted": False, "error": str(e)}, ensure_ascii=False, indent=1))
        return 1
    if args.coverage:
        args.coverage.write_bytes(file_bytes(coverage(args.root, Library(args.root))))
    print(json.dumps(summary, ensure_ascii=False, indent=1, default=str))
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
