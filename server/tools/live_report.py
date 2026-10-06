import argparse
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

APP = Path(__file__).resolve().parents[2]

PRICING = {
    "source": "https://api-docs.deepseek.com/quick_start/pricing/",
    "read_on": "2026-10-06",
    "model": "deepseek-v4-pro (the page lists model version DeepSeek-V4-Pro-0813)",
    "currency": "USD",
    "per_million_tokens_peak": {"input_cache_hit": 0.044, "input_cache_miss": 1.32, "output": 3.96},
    "per_million_tokens_off_peak": {"input_cache_hit": 0.022, "input_cache_miss": 0.66, "output": 1.98},
    "peak_windows_utc": "01:00-04:00 and 06:00-10:00, Monday to Friday, excluding Chinese public holidays",
    "estimate_basis": (
        "estimated_cost_usd_peak applies the peak rates to every attempt (the conservative figure). "
        "estimated_cost_usd_by_hour_window applies the rate implied by the published hour window for the "
        "attempt's start time; it does not account for Chinese public holidays, which would make it off-peak. "
        "Reasoning tokens are part of completion_tokens and are not added again. Prompt tokens without a "
        "reported cache split are priced as cache misses. Attempts without reported usage have unknown cost."
    ),
    "not_a_bill": "Estimates only. They are not reconciled with the DeepSeek account bill.",
}


def is_peak(started: datetime) -> bool:
    utc = started.astimezone(timezone.utc)
    if utc.weekday() >= 5:
        return False
    return 1 <= utc.hour < 4 or 6 <= utc.hour < 10


def cost(usage: dict | None, rates: dict) -> float | None:
    if not usage or usage.get("prompt_tokens") is None or usage.get("completion_tokens") is None:
        return None
    hit = usage.get("prompt_cache_hit_tokens")
    miss = usage.get("prompt_cache_miss_tokens")
    if hit is None or miss is None:
        hit, miss = 0, usage["prompt_tokens"]
    total = hit * rates["input_cache_hit"] + miss * rates["input_cache_miss"] + usage["completion_tokens"] * rates["output"]
    return round(total / 1_000_000, 6)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build LIVE_RUNS.json from the local generation ledger.")
    parser.add_argument("--ledger-dir", type=Path, default=APP / "var")
    parser.add_argument("--out", type=Path, default=APP / "docs" / "review" / "G2")
    parser.add_argument("--write-evidence", action="store_true", help="also update content/evidence/generation-tested.json")
    args = parser.parse_args()
    lines = (args.ledger_dir / "generation-ledger.jsonl").read_text(encoding="utf-8").splitlines()
    attempts = []
    responses = args.out / "live" / "responses"
    responses.mkdir(parents=True, exist_ok=True)
    for line in lines:
        if not line.strip():
            continue
        record = json.loads(line)
        started = datetime.fromisoformat(record["started_at"])
        peak = is_peak(started)
        record["published_hour_window"] = "peak" if peak else "off-peak"
        record["estimated_cost_usd_peak"] = cost(record["usage"], PRICING["per_million_tokens_peak"])
        window_rates = PRICING["per_million_tokens_peak" if peak else "per_million_tokens_off_peak"]
        record["estimated_cost_usd_by_hour_window"] = cost(record["usage"], window_rates)
        if record.get("response_file"):
            source = args.ledger_dir / record["response_file"]
            if source.is_file():
                shutil.copyfile(source, responses / source.name)
                record["response_file"] = f"live/responses/{source.name}"
        attempts.append(record)
    known = [a for a in attempts if a["estimated_cost_usd_peak"] is not None]
    totals = {
        "attempts": len(attempts),
        "logical_requests": len({a["request_id"] for a in attempts}),
        "outcomes": {o: sum(1 for a in attempts if a["outcome"] == o) for o in sorted({a["outcome"] for a in attempts})},
        "attempts_with_unknown_usage": len(attempts) - len(known),
        "prompt_tokens": sum(a["usage"]["prompt_tokens"] for a in known),
        "completion_tokens": sum(a["usage"]["completion_tokens"] for a in known),
        "reasoning_tokens_within_completion": sum(a["usage"].get("reasoning_tokens") or 0 for a in known),
        "estimated_cost_usd_peak": round(sum(a["estimated_cost_usd_peak"] for a in known), 6),
        "estimated_cost_usd_by_hour_window": round(sum(a["estimated_cost_usd_by_hour_window"] for a in known), 6),
    }
    document = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "ledger": "app/var/generation-ledger.jsonl (local development ledger, not packaged)",
        "pricing_assumptions": PRICING,
        "totals": totals,
        "attempts": attempts,
    }
    (args.out / "LIVE_RUNS.json").write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.write_evidence:
        write_evidence(attempts)
    print(json.dumps(totals, ensure_ascii=False))


def write_evidence(attempts: list[dict]) -> None:
    locales: dict[str, dict] = {}
    for a in attempts:
        if a["outcome"] != "success":
            continue
        entry = locales.setdefault(
            a["target_locale"], {"first_passed_at": a["started_at"], "levels": [], "sources": [], "request_ids": []}
        )
        for key, value in (("levels", a["level"]), ("sources", a["source_id"]), ("request_ids", a["request_id"])):
            if value not in entry[key]:
                entry[key].append(value)
    document = {
        "meaning": "A live DeepSeek draft in this locale passed the app's structural and provenance checks. "
        "This is not a content or language review.",
        "locales": dict(sorted(locales.items())),
    }
    path = APP / "content" / "evidence" / "generation-tested.json"
    path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
