import asyncio
import json
import time

import httpx
import pytest

from balligh import lesson_pipeline
from balligh.config import GenerationSettings
from balligh.lesson_pipeline import ClientDisconnected, GenerationError, run_until_disconnected
from balligh.providers.deepseek import DeepSeekClient
from helpers import ScriptedDeepSeek, completion, generate_request, lesson_output, lesson_reply, make_service


def run(service, request_id="11111111-2222-4333-8444-555555555555"):
    async def go():
        prepared = service.prepare(generate_request(request_id=request_id))
        return await service.run(prepared)

    return asyncio.run(go())


def failure(service, **kwargs) -> GenerationError:
    with pytest.raises(GenerationError) as e:
        run(service, **kwargs)
    return e.value


def ledger(tmp_path):
    path = tmp_path / "generation-ledger.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


@pytest.mark.parametrize(
    "status,code,retryable",
    [
        (401, "provider_auth", False),
        (402, "provider_balance", False),
        (400, "provider_rejected", False),
        (422, "provider_rejected", False),
    ],
)
def test_non_transient_statuses_stop_immediately(tmp_path, status, code, retryable):
    scripted = ScriptedDeepSeek(httpx.Response(status, json={"error": {"type": "x_error", "message": "no"}}))
    service, sleeper = make_service(scripted, tmp_path)
    err = failure(service)
    assert (err.code, err.retryable) == (code, retryable)
    assert len(scripted.requests) == 1 and sleeper.delays == []
    assert [r["outcome"] for r in ledger(tmp_path)] == [f"http_{status}"]
    assert service.admission.active == 0


@pytest.mark.parametrize("status", [429, 500, 503])
def test_transient_status_gets_exactly_one_retry(tmp_path, status):
    scripted = ScriptedDeepSeek(httpx.Response(status), lesson_reply())
    service, sleeper = make_service(scripted, tmp_path)
    draft = run(service)
    assert draft.generation.origin == "live"
    assert len(scripted.requests) == 2 and sleeper.delays == [2.0]
    records = ledger(tmp_path)
    assert [(r["attempt"], r["retry_count"], r["outcome"]) for r in records] == [
        (1, 0, f"http_{status}"),
        (2, 1, "success"),
    ]


@pytest.mark.parametrize("status", [429, 500, 503])
def test_second_transient_failure_is_final(tmp_path, status):
    scripted = ScriptedDeepSeek(httpx.Response(status), httpx.Response(status))
    service, sleeper = make_service(scripted, tmp_path)
    err = failure(service)
    assert err.code == "provider_busy" and err.retryable is True
    assert len(scripted.requests) == 2 and len(sleeper.delays) == 1


@pytest.mark.parametrize("header,expected", [("3", 3.0), ("60", 5.0), ("soon", 2.0), ("0", 0.0)])
def test_retry_after_is_honoured_within_bounds(header, expected):
    scripted = ScriptedDeepSeek(httpx.Response(429, headers={"Retry-After": header}), lesson_reply())
    service, sleeper = make_service(scripted)
    run(service)
    assert sleeper.delays == [expected]


@pytest.mark.parametrize(
    "error,code",
    [
        (httpx.ReadTimeout("slow"), "provider_timeout"),
        (httpx.ConnectTimeout("no route"), "provider_network"),
        (httpx.ConnectError("refused"), "provider_network"),
        (httpx.RemoteProtocolError("closed"), "provider_network"),
    ],
)
def test_timeouts_and_network_errors_are_not_retried(tmp_path, error, code):
    scripted = ScriptedDeepSeek(error)
    service, sleeper = make_service(scripted, tmp_path)
    err = failure(service)
    assert err.code == code and err.retryable is True
    assert len(scripted.requests) == 1 and sleeper.delays == []
    assert service.admission.active == 0


def test_hard_attempt_deadline_ends_a_connection_that_never_completes():
    async def stall(request):
        await asyncio.sleep(5)
        return lesson_reply()

    scripted = ScriptedDeepSeek(stall)
    service, _ = make_service(scripted, attempt_deadline_s=0.2)
    started = time.monotonic()
    err = failure(service)
    assert err.code == "provider_timeout"
    assert time.monotonic() - started < 3
    assert len(scripted.requests) == 1


@pytest.mark.parametrize(
    "reply,reason",
    [
        (completion("{not json"), "malformed_json"),
        (completion(""), "empty_content"),
        (completion(None), "empty_content"),
        (completion('{"status": "ok"}'), "wrong_shape"),
        (completion(json.dumps({"status": "ok"}), finish_reason="length"), "finish_reason_length"),
        (completion("{}", finish_reason="content_filter"), "finish_reason_content_filter"),
        (completion("{}", finish_reason="insufficient_system_resource"), "finish_reason_insufficient_system_resource"),
        (completion("{}", finish_reason=None), "finish_reason_missing"),
        (httpx.Response(200, json={"choices": []}), "response_shape"),
    ],
)
def test_invalid_output_fails_once_and_keeps_usage(tmp_path, reply, reason):
    scripted = ScriptedDeepSeek(reply)
    service, sleeper = make_service(scripted, tmp_path)
    err = failure(service)
    assert err.code == "invalid_output" and err.retryable is True and err.diagnostic_id
    assert len(scripted.requests) == 1 and sleeper.delays == []
    (record,) = ledger(tmp_path)
    assert record["outcome"] == f"invalid_output:{reason}"
    if reason != "response_shape":
        assert record["usage"]["completion_tokens"] == 2500


def test_non_json_provider_body_is_an_invalid_output():
    scripted = ScriptedDeepSeek(httpx.Response(200, content=b"<html>proxy</html>"))
    service, _ = make_service(scripted)
    assert failure(service).code == "invalid_output"


def test_missing_usage_is_recorded_as_unknown(tmp_path):
    scripted = ScriptedDeepSeek(completion(json.dumps(lesson_output(), ensure_ascii=False), usage=None))
    service, _ = make_service(scripted, tmp_path)
    draft = run(service)
    assert draft.generation.usage is None
    assert ledger(tmp_path)[0]["usage"] is None


def test_insufficient_context_preserves_work_and_records_usage(tmp_path):
    scripted = ScriptedDeepSeek(completion('{"status": "insufficient_context", "reason": "Too short."}'))
    service, _ = make_service(scripted, tmp_path)
    err = failure(service)
    assert err.code == "insufficient_context" and err.status == 422
    (record,) = ledger(tmp_path)
    assert record["outcome"] == "insufficient_context" and record["usage"]["total_tokens"] == 4300


def test_admission_allows_two_in_flight_and_rejects_a_third_without_calling():
    async def scenario():
        gate = asyncio.Event()

        async def held(request):
            await gate.wait()
            return lesson_reply()

        scripted = ScriptedDeepSeek(held, held, lesson_reply())
        service, _ = make_service(scripted)
        ids = [f"{n}1111111-2222-4333-8444-555555555555" for n in range(1, 5)]
        first = asyncio.ensure_future(service.run(service.prepare(generate_request(request_id=ids[0]))))
        second = asyncio.ensure_future(service.run(service.prepare(generate_request(request_id=ids[1]))))
        await asyncio.sleep(0.05)
        assert service.admission.active == 2
        with pytest.raises(GenerationError) as busy:
            await service.run(service.prepare(generate_request(request_id=ids[2])))
        assert busy.value.code == "busy" and busy.value.retryable is True
        assert len(scripted.requests) == 2
        gate.set()
        await asyncio.gather(first, second)
        assert service.admission.active == 0
        await service.run(service.prepare(generate_request(request_id=ids[3])))
        assert service.admission.active == 0 and len(scripted.requests) == 3

    asyncio.run(scenario())


def test_slot_is_released_after_failure_and_cancellation(tmp_path):
    async def scenario():
        async def never(request):
            await asyncio.sleep(30)

        scripted = ScriptedDeepSeek(httpx.Response(401), never)
        service, _ = make_service(scripted, tmp_path)
        with pytest.raises(GenerationError):
            await service.run(service.prepare(generate_request(request_id="a1111111-2222-4333-8444-555555555555")))
        assert service.admission.active == 0
        task = asyncio.ensure_future(
            service.run(service.prepare(generate_request(request_id="b1111111-2222-4333-8444-555555555555")))
        )
        await asyncio.sleep(0.05)
        assert service.admission.active == 1
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert service.admission.active == 0
        return ledger(tmp_path)

    records = asyncio.run(scenario())
    assert [r["outcome"] for r in records] == ["http_401", "cancelled"]
    assert records[1]["usage"] is None


def test_client_disconnect_cancels_the_running_generation():
    async def scenario():
        async def never(request):
            await asyncio.sleep(30)

        scripted = ScriptedDeepSeek(never)
        service, _ = make_service(scripted)
        polls = {"n": 0}

        async def is_disconnected():
            polls["n"] += 1
            return polls["n"] >= 2

        prepared = service.prepare(generate_request())
        with pytest.raises(ClientDisconnected):
            await run_until_disconnected(is_disconnected, service.run(prepared), poll_s=0.01)
        assert service.admission.active == 0

    asyncio.run(scenario())


def test_transport_has_no_hidden_retries(monkeypatch):
    captured = {}

    class FakeTransport(httpx.AsyncBaseTransport):
        def __init__(self, **kwargs):
            captured.update(kwargs)

        async def handle_async_request(self, request):
            return lesson_reply()

    monkeypatch.setattr(httpx, "AsyncHTTPTransport", FakeTransport)
    client = DeepSeekClient("key", GenerationSettings())
    reply = asyncio.run(client.create({"model": "deepseek-v4-pro"}))
    assert captured == {"retries": 0}
    assert reply.body["model"] == "deepseek-v4-pro"
    assert "key" not in repr(client)


def test_default_generation_settings_match_the_instruction():
    cfg = GenerationSettings()
    assert (cfg.model, cfg.thinking, cfg.reasoning_effort, cfg.response_format, cfg.max_tokens) == (
        "deepseek-v4-pro",
        "enabled",
        "high",
        "json_object",
        16384,
    )
    assert (cfg.connect_timeout_s, cfg.attempt_deadline_s, cfg.max_in_flight) == (10.0, 180.0, 2)
    assert cfg.retry_statuses == frozenset({429, 500, 503})
    assert cfg.endpoint == "https://api.deepseek.com/chat/completions"
    assert lesson_pipeline.PROMPT_VERSION == "g5c-lesson-3"
