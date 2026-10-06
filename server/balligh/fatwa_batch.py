"""Scheduling for the fatwa translation batch: an absolute stop time, an attempt ceiling and at most two requests in flight.

The stop time and the ceiling are checked after semaphore admission and immediately before every request, including a
retry after backoff. A request that was admitted before the stop may still finish after it; no new request starts.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Iterable

RIYADH = timezone(timedelta(hours=3))
MAX_IN_FLIGHT = 2


def parse_stop_at(value: str, now: datetime) -> datetime:
    """An explicit offset-aware ISO 8601 deadline, e.g. 2026-10-07T00:45:00+03:00. Naive or past values are refused."""
    try:
        stop = datetime.fromisoformat(value.strip())
    except ValueError:
        raise ValueError("stop-at must be an ISO 8601 timestamp with an offset, e.g. 2026-10-07T00:45:00+03:00") from None
    if stop.tzinfo is None or stop.utcoffset() is None:
        raise ValueError("stop-at needs an explicit UTC offset; a naive timestamp is ambiguous")
    if stop <= now:
        raise ValueError("stop-at is already past; no request is made and the deadline is not moved to another day")
    return stop


def parse_stop_hhmm(value: str, now: datetime) -> datetime:
    """The older --stop HH:MM form: today in Riyadh only. A time that is not later today is refused, never rolled over."""
    try:
        hh, mm = (int(x) for x in value.strip().split(":"))
        local = now.astimezone(RIYADH)
        stop = local.replace(hour=hh, minute=mm, second=0, microsecond=0)
    except ValueError:
        raise ValueError("stop must be HH:MM") from None
    if stop <= local:
        raise ValueError("--stop HH:MM is not later today in Riyadh; use --stop-at with a full offset-aware timestamp")
    return stop


@dataclass
class Budget:
    stop_at: datetime
    max_attempts: int
    attempts: int = 0

    def may_start(self, now: datetime) -> bool:
        return now < self.stop_at and self.attempts < self.max_attempts


Outcome = tuple[str, dict[str, Any]]  # ("ok" | "retry" | "fail", details)


async def run_queue(
    jobs: Iterable[Any],
    attempt: Callable[[Any, int], Awaitable[Outcome]],
    budget: Budget,
    *,
    concurrency: int = MAX_IN_FLIGHT,
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    backoff_s: float = 5.0,
    on_event: Callable[[Any, int, Outcome], None] = lambda job, n, outcome: None,
) -> dict[str, int]:
    sem = asyncio.Semaphore(max(1, min(MAX_IN_FLIGHT, concurrency)))
    stats = {"ok": 0, "failed": 0, "attempts": 0, "not_started": 0, "retry_not_started": 0}

    async def one(job: Any) -> None:
        async with sem:
            for n in (1, 2):
                if not budget.may_start(now()):
                    stats["not_started" if n == 1 else "retry_not_started"] += 1
                    if n == 2:
                        stats["failed"] += 1
                    return
                budget.attempts += 1
                stats["attempts"] += 1
                outcome = await attempt(job, n)
                on_event(job, n, outcome)
                if outcome[0] == "ok":
                    stats["ok"] += 1
                    return
                if outcome[0] == "fail" or n == 2:
                    stats["failed"] += 1
                    return
                await sleep(backoff_s)

    await asyncio.gather(*(one(j) for j in jobs))
    return stats
