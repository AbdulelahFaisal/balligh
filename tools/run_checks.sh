#!/usr/bin/env bash
set -u
APP="$(pwd)"
[ -e "$APP/.env" ] && { echo "refusing to run: app/.env is present; run in a clean verification copy" >&2; exit 2; }
if [ $# -gt 0 ]; then
  DIR="$1"
  [ -e "$DIR" ] && { echo "refusing to run: $DIR already exists; choose a new output directory" >&2; exit 2; }
  { mkdir -p -- "$(dirname -- "$DIR")" && mkdir -- "$DIR"; } || { echo "cannot create $DIR" >&2; exit 3; }
else
  { mkdir -p -- "$APP/var/checks" && DIR="$(mktemp -d "$APP/var/checks/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"; } ||
    { echo "cannot create an output directory under $APP/var/checks" >&2; exit 3; }
fi
OUT="$DIR/test-results.txt"
PY="$APP/.venv/Scripts/python"
[ -x "$PY" ] || PY="$APP/.venv/bin/python"
FAILED=0

run() {
  local dir="$1"; shift
  local cmd="$*"
  local start; start="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  local log; log="$(cd "$dir" && eval "$cmd" 2>&1)"
  local code=$?
  [ $code -eq 0 ] || FAILED=$((FAILED + 1))
  {
    echo "=== ${cmd//$APP/app}"
    echo "cwd: ${dir#$APP/}  started: $start  exit: $code  result: $([ $code -eq 0 ] && echo PASS || echo FAIL)"
    echo "$log" | sed 's/\x1b\[[0-9;]*m//g' | tail -n 25
    echo
  } >> "$OUT" || { echo "cannot write $OUT" >&2; FAILED=$((FAILED + 1)); }
  echo "$code  ${cmd//$APP/app}"
}

{
  echo "Balligh checks — test results (default commands: no provider calls; the test server does not read app/.env)"
  echo "Generated: $(date '+%Y-%m-%dT%H:%M:%S%z') (Asia/Riyadh)"
  echo "node $(node --version), npm $(npm --version), $("$PY" --version)"
  echo
} > "$OUT" || { echo "cannot write $OUT" >&2; exit 3; }

run "$APP/server" "\"$PY\" -m pytest -q"
run "$APP/server" "\"$PY\" -m pytest -q tests/test_import_isolation.py -v"
run "$APP" "\"$PY\" server/tools/library/verify_library.py"
run "$APP/web" "npm run typecheck"
run "$APP/web" "npm test"
run "$APP/web" "npm run build"
run "$APP/web" "npx playwright test e2e/generation.spec.ts e2e/journey.spec.ts e2e/repairs.spec.ts e2e/storage-p2.spec.ts e2e/consistency.spec.ts e2e/g3.spec.ts e2e/g3p1.spec.ts e2e/library.spec.ts e2e/library-p1.spec.ts e2e/g4b-learn.spec.ts e2e/g4b-teacher.spec.ts e2e/g4b-audio.spec.ts e2e/g4bp1-quran.spec.ts e2e/g4bp1-reading.spec.ts e2e/g4bp1-setup.spec.ts e2e/g4bp1-usability.spec.ts e2e/g4bp2-quran-restore.spec.ts"

echo "failed checks: $FAILED" >> "$OUT" || { echo "cannot write $OUT" >&2; FAILED=$((FAILED + 1)); }
echo "results: $OUT"
[ "$FAILED" -eq 0 ] || exit 1
