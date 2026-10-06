import asyncio
import json
import shutil
from dataclasses import replace
from pathlib import Path
from typing import Any, Callable, Optional, Union

import httpx

from balligh.config import APP_ROOT, Settings, load_settings
from balligh.lesson_pipeline import GenerateRequest, GenerationService, load_glossary
from balligh.ledger import Ledger
from balligh.sources import load_registry

CONTENT = APP_ROOT / "content"
CANARY_KEY = "sk-canary-7f3e9a1c5b2d4e6f8a0b1c2d3e4f5a6b"
LOCAL_NOTE = "src-g1-local-note-ar"
DEFAULT_USAGE = {
    "prompt_tokens": 1800,
    "completion_tokens": 2500,
    "total_tokens": 4300,
    "prompt_cache_hit_tokens": 0,
    "prompt_cache_miss_tokens": 1800,
    "completion_tokens_details": {"reasoning_tokens": 2100},
}

Step = Union[httpx.Response, Exception, Callable[[httpx.Request], Any]]


class ScriptedDeepSeek:
    def __init__(self, *steps: Step) -> None:
        self.steps = list(steps)
        self.requests: list[httpx.Request] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    async def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self.steps:
            raise AssertionError("unexpected extra provider call")
        step = self.steps.pop(0)
        if isinstance(step, Exception):
            raise step
        if isinstance(step, httpx.Response):
            return step
        result = step(request)
        if asyncio.iscoroutine(result):
            result = await result
        return result

    @property
    def bodies(self) -> list[dict[str, Any]]:
        return [json.loads(r.content) for r in self.requests]


def completion(
    content: Optional[str],
    finish_reason: Optional[str] = "stop",
    model: Optional[str] = "deepseek-v4-pro",
    usage: Optional[dict[str, Any]] = DEFAULT_USAGE,
) -> httpx.Response:
    body: dict[str, Any] = {
        "id": "cmpl-test",
        "object": "chat.completion",
        "choices": [
            {
                "index": 0,
                "finish_reason": finish_reason,
                "message": {"role": "assistant", "content": content, "reasoning_content": "private reasoning"},
            }
        ],
    }
    if model is not None:
        body["model"] = model
    if usage is not None:
        body["usage"] = usage
    return httpx.Response(200, json=body)


def lesson_output(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "status": "ok",
        "title": "Citing, quoting and translating",
        "cards": [
            {"kind": "translation", "text": "Citing the source is a scholarly habit that keeps trust.", "evidence": ["s1"]},
            {
                "kind": "explanation",
                "text": "A quotation keeps the writer's words; an explanation is our own understanding.",
                "evidence": ["s2", "s3"],
            },
            {
                "kind": "translation",
                "text": "A translation needs review by someone fluent in both languages before it is published.",
                "evidence": ["s4"],
            },
        ],
        "terms": [
            {"source_form": "الإحالة", "display_form": "citation (iḥāla)", "meaning": "Naming the source of a passage."}
        ],
        "activity": {
            "question": "What should happen before a translation is published?",
            "options": ["Publish it at once", "Have someone fluent in both languages review it", "Remove the source"],
            "correct_option": 1,
            "rationale": "The source says a translation needs review before it is published.",
            "evidence": ["s4"],
        },
    }
    data.update(overrides)
    return data


def lesson_reply(**overrides: Any) -> httpx.Response:
    return completion(json.dumps(lesson_output(**overrides), ensure_ascii=False))


def offline_settings(**overrides: Any) -> Settings:
    return replace(load_settings(env_file=None, environ={}), **{"ledger_dir": None, **overrides})


def keyed_settings(ledger_dir: Optional[Path] = None, **generation: Any) -> Settings:
    base = offline_settings(deepseek_api_key=CANARY_KEY, ledger_dir=ledger_dir)
    if generation:
        base = replace(base, generation=replace(base.generation, **generation))
    return base


def request_body(request_id: str = "11111111-2222-4333-8444-555555555555", **overrides: Any) -> dict[str, Any]:
    registry = load_registry(CONTENT)
    record = registry.sources[LOCAL_NOTE]
    body = {
        "request_id": request_id,
        "source_id": LOCAL_NOTE,
        "source_version": record.source_version,
        "source_sha256": record.content_sha256,
        "target_locale": "en",
        "level": "foundational",
    }
    body.update(overrides)
    return body


class RecordingSleep:
    def __init__(self) -> None:
        self.delays: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.delays.append(seconds)


def make_service(
    scripted: ScriptedDeepSeek,
    ledger_dir: Optional[Path] = None,
    content_dir: Path = CONTENT,
    **generation: Any,
) -> tuple[GenerationService, RecordingSleep]:
    settings = replace(keyed_settings(ledger_dir, **generation), content_dir=content_dir)
    sleeper = RecordingSleep()
    service = GenerationService(
        settings=settings,
        registry=load_registry(content_dir),
        glossary=load_glossary(content_dir),
        ledger=Ledger(ledger_dir) if ledger_dir else None,
        transport=scripted.transport(),
        sleep=sleeper,
    )
    return service, sleeper


def generate_request(**overrides: Any) -> GenerateRequest:
    return GenerateRequest.model_validate(request_body(**overrides))


def copy_content(target: Path) -> Path:
    shutil.copytree(CONTENT, target)
    return target
