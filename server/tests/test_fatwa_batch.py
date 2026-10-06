import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from balligh.fatwa_batch import RIYADH, Budget, parse_stop_at, parse_stop_hhmm, run_queue

BEFORE_MIDNIGHT = datetime(2026, 10, 6, 23, 50, tzinfo=RIYADH)
STOP = "2026-10-07T00:45:00+03:00"


class Clock:
    def __init__(self, start):
        self.t = start

    def now(self):
        return self.t

    async def sleep(self, seconds):
        self.t += timedelta(seconds=seconds)


def test_next_day_deadline_is_accepted_before_midnight():
    stop = parse_stop_at(STOP, BEFORE_MIDNIGHT)
    assert stop == datetime(2026, 10, 7, 0, 45, tzinfo=RIYADH)
    assert Budget(stop, 10).may_start(BEFORE_MIDNIGHT)
    assert parse_stop_at("2026-10-06T21:45:00+00:00", BEFORE_MIDNIGHT) == stop


@pytest.mark.parametrize("value", ["2026-10-06T23:45:00+03:00", "2026-10-07T00:45:00", "00:45", "tomorrow", ""])
def test_expired_naive_or_ambiguous_deadlines_are_refused(value):
    with pytest.raises(ValueError):
        parse_stop_at(value, BEFORE_MIDNIGHT)


def test_old_hhmm_form_is_today_only_and_never_rolls_to_tomorrow():
    assert parse_stop_hhmm("23:55", BEFORE_MIDNIGHT) == datetime(2026, 10, 6, 23, 55, tzinfo=RIYADH)
    with pytest.raises(ValueError):
        parse_stop_hhmm("00:45", BEFORE_MIDNIGHT)
    with pytest.raises(ValueError):
        parse_stop_hhmm("23:50", BEFORE_MIDNIGHT)


def run(jobs, attempt, budget, clock, concurrency=2):
    return asyncio.run(run_queue(jobs, attempt, budget, concurrency=concurrency, now=clock.now, sleep=clock.sleep, backoff_s=5))


def test_jobs_cross_midnight_and_nothing_starts_after_the_stop():
    clock = Clock(datetime(2026, 10, 6, 23, 59, 30, tzinfo=RIYADH))
    budget = Budget(parse_stop_at(STOP, clock.now()), 1000)
    started = []

    async def attempt(job, n):
        started.append((job, clock.now()))
        clock.t += timedelta(minutes=10)
        return "ok", {}

    stats = run(list(range(8)), attempt, budget, clock, concurrency=1)
    assert [t for _, t in started][-1] < budget.stop_at
    assert started[1][1].date().isoformat() == "2026-10-07"
    assert stats["ok"] == 5 and stats["not_started"] == 3 and stats["attempts"] == 5


def test_a_retry_whose_backoff_ends_after_the_stop_does_not_start():
    clock = Clock(datetime(2026, 10, 7, 0, 44, 58, tzinfo=RIYADH))
    budget = Budget(parse_stop_at(STOP, clock.now()), 1000)
    calls = []

    async def attempt(job, n):
        calls.append(n)
        return "retry", {}

    stats = run(["a"], attempt, budget, clock)
    assert calls == [1]
    assert stats == {"ok": 0, "failed": 1, "attempts": 1, "not_started": 0, "retry_not_started": 1}


def test_the_attempt_ceiling_counts_failures_and_retries():
    clock = Clock(BEFORE_MIDNIGHT)
    budget = Budget(parse_stop_at(STOP, clock.now()), 5)
    calls = []

    async def attempt(job, n):
        calls.append((job, n))
        return ("retry", {}) if job == "a" else ("ok", {})

    stats = run(["a", "b", "c", "d", "e", "f"], attempt, budget, clock, concurrency=1)
    assert len(calls) == 5 and budget.attempts == 5
    assert stats["attempts"] == 5 and stats["ok"] == 3 and stats["not_started"] == 2


def test_at_most_two_requests_are_in_flight():
    clock = Clock(BEFORE_MIDNIGHT)
    budget = Budget(parse_stop_at(STOP, clock.now()), 100)
    live = peak = 0

    async def attempt(job, n):
        nonlocal live, peak
        live += 1
        peak = max(peak, live)
        await asyncio.sleep(0)
        live -= 1
        return "ok", {}

    asyncio.run(run_queue(list(range(12)), attempt, budget, concurrency=9, now=clock.now))
    assert peak <= 2
