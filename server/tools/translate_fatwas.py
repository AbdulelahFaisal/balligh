"""Resumable batch of AI-assisted fatwa translations (billed). One record per locale per request, at most 2 in flight.

usage: python server/tools/translate_fatwas.py --stop HH:MM [--records id,id] [--locales en,ur] [--concurrency 2]
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
from balligh.providers.deepseek import DeepSeekClient, ProviderFailure  # noqa: E402

LEARN_FIRST = ["binbaz-11423", "binbaz-18975", "binbaz-3982", "binbaz-3649", "binbaz-2774", "binbaz-18397", "binbaz-854"]
RIYADH = timezone(timedelta(hours=3))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stop", required=True, help="Riyadh HH:MM after which no new job starts")
    ap.add_argument("--records", default="")
    ap.add_argument("--locales", default=",".join(ft.LOCALES))
    ap.add_argument("--concurrency", type=int, default=2)
    args = ap.parse_args()
    settings = load_settings()
    if not settings.generation_configured or settings.generation.model != "deepseek-v4-pro":
        print("not configured or unexpected model; no call made")
        return 2
    records_dir = settings.content_dir / "library" / "fatwa" / "records"
    root = settings.content_dir / "translations" / "fatwa"
    ids = [x for x in args.records.split(",") if x] or LEARN_FIRST + sorted(
        p.stem for p in records_dir.glob("*.json") if p.stem not in LEARN_FIRST)
    locales = [x for x in args.locales.split(",") if x in ft.LOCALES]
    now = datetime.now(RIYADH)
    hh, mm = map(int, args.stop.split(":"))
    stop_at = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    log_dir = APP / "var" / "translation-runs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log = (log_dir / f"run-{now.strftime('%Y%m%dT%H%M%S')}.jsonl").open("a", encoding="utf-8")
    client = DeepSeekClient(settings.deepseek_api_key, settings.generation)
    jobs = []
    for rid in ids:
        record = json.loads((records_dir / f"{rid}.json").read_text(encoding="utf-8"))
        for loc in locales:
            if ft.valid_artifact(root, record, loc) is None:
                jobs.append((record, loc))
    print(f"jobs pending: {len(jobs)}; stop at {stop_at.strftime('%H:%M')} Riyadh")
    sem = asyncio.Semaphore(max(1, min(2, args.concurrency)))
    stats = {"ok": 0, "failed": 0, "attempts": 0, "skipped_stop": 0, "prompt_tokens": 0, "completion_tokens": 0}

    async def one(record, loc):
        async with sem:
            if datetime.now(RIYADH) >= stop_at:
                stats["skipped_stop"] += 1
                return
            for attempt in (1, 2):
                stats["attempts"] += 1
                started = time.monotonic()
                entry = {"record": record["id"], "locale": loc, "attempt": attempt, "at": datetime.now(RIYADH).isoformat()}
                try:
                    reply = await client.create(ft.build_payload(settings.generation.model, record, loc))
                    usage = reply.body.get("usage") or {}
                    stats["prompt_tokens"] += int(usage.get("prompt_tokens") or 0)
                    stats["completion_tokens"] += int(usage.get("completion_tokens") or 0)
                    units = ft.validate_reply(record, reply.body)
                    ft.write_artifact(root, record, loc, units, {
                        "provider": "deepseek", "model": reply.body.get("model") or settings.generation.model,
                        "usage": usage, "latency_ms": reply.latency_ms})
                    stats["ok"] += 1
                    entry.update(outcome="ok", latency_ms=reply.latency_ms, usage=usage)
                    log.write(json.dumps(entry, ensure_ascii=False) + "\n"); log.flush()
                    return
                except ProviderFailure as f:
                    entry.update(outcome=f"provider_{f.kind}", status=getattr(f, "status", None))
                    retry = f.kind in ("timeout", "network") or getattr(f, "status", 0) in (429, 500, 502, 503)
                except ValueError as e:
                    entry.update(outcome=f"invalid:{e}")
                    retry = True
                entry["elapsed_ms"] = int((time.monotonic() - started) * 1000)
                log.write(json.dumps(entry, ensure_ascii=False) + "\n"); log.flush()
                if not retry or attempt == 2 or datetime.now(RIYADH) >= stop_at:
                    stats["failed"] += 1
                    return
                await asyncio.sleep(5)

    async def run():
        await asyncio.gather(*(one(r, l) for r, l in jobs))

    t0 = time.monotonic()
    asyncio.run(run())
    stats["elapsed_s"] = round(time.monotonic() - t0, 1)
    print(json.dumps(stats))
    log.write(json.dumps({"summary": stats}) + "\n"); log.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
