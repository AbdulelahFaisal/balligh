"""Resumable batch of AI-assisted fatwa translations (billed). One record per locale per request, at most 2 in flight.

usage: python server/tools/translate_fatwas.py --stop-at 2026-10-07T00:45:00+03:00 [--max-attempts 650]
           [--records id,id] [--locales en,ur] [--concurrency 2]
The older `--stop HH:MM` (today in Riyadh) still works but is refused when that time is not later today.
The key is loaded by the application's settings (app/.env or the environment) and never printed.
"""
import argparse
import asyncio
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

APP = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(APP / "server"))
from balligh import fatwa_translation as ft  # noqa: E402
from balligh.config import load_settings  # noqa: E402
from balligh.fatwa_batch import RIYADH, Budget, parse_stop_at, parse_stop_hhmm, run_queue  # noqa: E402
from balligh.providers.deepseek import DeepSeekClient, ProviderFailure  # noqa: E402

LEARN_FIRST = ["binbaz-11423", "binbaz-18975", "binbaz-3982", "binbaz-3649", "binbaz-2774", "binbaz-18397", "binbaz-854", "binbaz-1158"]
GRACE = timedelta(minutes=3)  # an admitted request is cut off this long after the stop


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stop-at", default="", help="offset-aware ISO deadline after which no request starts")
    ap.add_argument("--stop", default="", help="older form: Riyadh HH:MM later today")
    ap.add_argument("--max-attempts", type=int, default=650)
    ap.add_argument("--records", default="")
    ap.add_argument("--locales", default=",".join(ft.LOCALES))
    ap.add_argument("--concurrency", type=int, default=2)
    args = ap.parse_args()
    now = datetime.now(timezone.utc)
    try:
        if args.stop_at:
            stop_at = parse_stop_at(args.stop_at, now)
        elif args.stop:
            stop_at = parse_stop_hhmm(args.stop, now)
        else:
            raise ValueError("give --stop-at (preferred) or --stop")
    except ValueError as e:
        print(f"refused before any provider call: {e}")
        return 2
    settings = load_settings()
    if not settings.generation_configured or settings.generation.model != "deepseek-v4-pro":
        print("not configured or unexpected model; no call made")
        return 2
    records_dir = settings.content_dir / "library" / "fatwa" / "records"
    root = settings.content_dir / "translations" / "fatwa"
    ids = [x for x in args.records.split(",") if x] or LEARN_FIRST + sorted(
        p.stem for p in records_dir.glob("*.json") if p.stem not in LEARN_FIRST)
    locales = [x for x in args.locales.split(",") if x in ft.LOCALES]
    log_dir = APP / "var" / "translation-runs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log = (log_dir / f"run-{now.astimezone(RIYADH).strftime('%Y%m%dT%H%M%S')}.jsonl").open("a", encoding="utf-8")
    client = DeepSeekClient(settings.deepseek_api_key, settings.generation)
    jobs = []
    for rid in ids:
        record = json.loads((records_dir / f"{rid}.json").read_text(encoding="utf-8"))
        for loc in locales:
            if ft.valid_artifact(root, record, loc) is None:
                jobs.append((record, loc))
    budget = Budget(stop_at=stop_at, max_attempts=max(0, args.max_attempts))
    print(f"jobs pending: {len(jobs)}; stop at {stop_at.isoformat()}; attempt ceiling {budget.max_attempts}", flush=True)
    usage_total = {"prompt_tokens": 0, "completion_tokens": 0}

    async def attempt(job, n):
        record, loc = job
        started = time.monotonic()
        entry = {"record": record["id"], "locale": loc, "attempt": n, "at": datetime.now(RIYADH).isoformat()}
        try:
            remaining = (stop_at + GRACE - datetime.now(timezone.utc)).total_seconds()
            async with asyncio.timeout(max(5.0, remaining)):
                reply = await client.create(ft.build_payload(settings.generation.model, record, loc))
            usage = reply.body.get("usage") or {}
            for k in usage_total:
                usage_total[k] += int(usage.get(k) or 0)
            units = ft.validate_reply(record, reply.body)
            ft.write_artifact(root, record, loc, units, {
                "provider": "deepseek", "model": reply.body.get("model") or settings.generation.model,
                "usage": usage, "latency_ms": reply.latency_ms})
            entry.update(outcome="ok", latency_ms=reply.latency_ms, usage=usage)
            result = ("ok", entry)
        except ProviderFailure as f:
            status = getattr(f, "status", None)
            entry.update(outcome=f"provider_{f.kind}", status=status)
            result = ("retry" if f.kind in ("timeout", "network") or status in (429, 500, 502, 503) else "fail", entry)
        except TimeoutError:
            entry.update(outcome="cut_off_after_stop")
            result = ("fail", entry)
        except ValueError as e:
            entry.update(outcome=f"invalid:{e}")
            result = ("retry", entry)
        entry["elapsed_ms"] = int((time.monotonic() - started) * 1000)
        log.write(json.dumps(entry, ensure_ascii=False) + "\n")
        log.flush()
        return result

    t0 = time.monotonic()
    stats = asyncio.run(run_queue(jobs, attempt, budget, concurrency=args.concurrency))
    stats.update(usage_total, elapsed_s=round(time.monotonic() - t0, 1))
    print(json.dumps(stats), flush=True)
    log.write(json.dumps({"summary": stats}) + "\n")
    log.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
