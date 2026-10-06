import asyncio
import hashlib
import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from balligh import lesson_pipeline
from balligh.api import create_app
from balligh.lesson_pipeline import GenerationError, InvalidOutput, ModelCard, build_messages, parse_lesson_output
from balligh.schemas import LessonDraft
from balligh.sources import load_registry, validate_draft
from helpers import (
    CONTENT,
    RecordingSleep,
    ScriptedDeepSeek,
    completion,
    generate_request,
    keyed_settings,
    lesson_output,
    make_service,
    request_body,
)

LIVE = (
    Path(__file__).resolve().parent
    / "fixtures"
    / "g4b"
    / "live-draft-en-foundational-lib-fatwa-18975-ccd2d268.json"
)
LIVE_SHA256 = "4a84fd5170b8615c4aebc67f78c9bc1bf87ea3a39866f68f556229c84923efe9"
PREVIOUS_PROMPT_VERSION = "g2-lesson-1"
CARD_LIMIT = re.compile(r'"text" \(at most (\d+) characters')


def client(scripted: ScriptedDeepSeek) -> TestClient:
    return TestClient(create_app(keyed_settings(), transport=scripted.transport(), sleep=RecordingSleep()))


def parser_card_limit() -> int:
    (limit,) = {m.max_length for m in ModelCard.model_fields["text"].metadata if getattr(m, "max_length", None)}
    return limit


def card_text(length: int) -> str:
    unit = "Citing the source keeps trust, unless the source is unknown, and the condition is not dropped. "
    text = (unit * (length // len(unit) + 1))[: length - 1].rstrip()
    return text + "." * (length - len(text))


def with_first_card(text: str) -> dict:
    out = lesson_output()
    out["cards"] = [{**out["cards"][0], "text": text}, *out["cards"][1:]]
    return out


def reply_with_first_card(text: str):
    return completion(json.dumps(with_first_card(text), ensure_ascii=False))


def sent(scripted: ScriptedDeepSeek) -> tuple[list[dict], dict]:
    (body,) = scripted.bodies
    messages = body["messages"]
    return messages, json.loads(messages[1]["content"].split("\n", 1)[1])


def stated_card_limit(task: dict) -> int:
    (rule,) = [r for r in task["output_format"] if r.startswith('"cards"')]
    (stated,) = CARD_LIMIT.findall(rule)
    return int(stated)


def test_request_states_exactly_the_card_limit_the_parser_enforces():
    scripted = ScriptedDeepSeek(reply_with_first_card(card_text(120)))
    r = client(scripted).post("/api/drafts/generate", json=request_body())
    assert r.status_code == 200, r.text
    messages, task = sent(scripted)
    limit = parser_card_limit()
    assert limit == lesson_pipeline.MAX_CARD_CHARS
    assert stated_card_limit(task) == limit
    registry = load_registry(CONTENT)
    record = registry.sources[request_body()["source_id"]]
    assert task["source"]["text"] == registry.texts[record.id]
    assert messages[0] == {"role": "system", "content": lesson_pipeline.SYSTEM_PROMPT}
    assert messages[1]["content"].startswith("Prepare the lesson described in this JSON.")
    stated = stated_card_limit(task)
    accepted = parse_lesson_output(json.dumps(with_first_card(card_text(stated))))
    assert len(accepted.cards[0].text) == stated
    with pytest.raises(InvalidOutput):
        parse_lesson_output(json.dumps(with_first_card(card_text(stated + 1))))


def test_build_messages_carries_the_same_limit_for_every_level_and_locale():
    registry = load_registry(CONTENT)
    scripted = ScriptedDeepSeek()
    service, _ = make_service(scripted)
    prepared = service.prepare(generate_request())
    for locale in lesson_pipeline.GENERATION_LOCALES:
        for level in ("foundational", "detailed"):
            messages = build_messages(
                registry.texts[prepared.record.id], prepared.segments, locale, level, service.glossary
            )
            task = json.loads(messages[1]["content"].split("\n", 1)[1])
            assert stated_card_limit(task) == parser_card_limit()
    assert scripted.requests == []


def test_long_faithful_card_from_the_provider_is_accepted_with_the_new_prompt_version():
    text = card_text(1500)
    scripted = ScriptedDeepSeek(reply_with_first_card(text))
    r = client(scripted).post("/api/drafts/generate", json=request_body())
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["valid"] is True and data["errors"] == []
    draft = data["draft"]
    assert len(draft["cards"][0]["text"]) == 1500 and draft["cards"][0]["text"] == text
    assert draft["cards"][0]["derivation"] == "machine_translation"
    assert draft["generation"]["prompt_version"] == lesson_pipeline.PROMPT_VERSION
    assert lesson_pipeline.PROMPT_VERSION != PREVIOUS_PROMPT_VERSION
    assert len(scripted.requests) == 1


def test_card_over_the_parser_limit_is_rejected_as_invalid_output(tmp_path):
    scripted = ScriptedDeepSeek(reply_with_first_card(card_text(parser_card_limit() + 1)))
    service, sleeper = make_service(scripted, tmp_path)

    async def go():
        return await service.run(service.prepare(generate_request()))

    with pytest.raises(GenerationError) as e:
        asyncio.run(go())
    assert e.value.code == "invalid_output" and e.value.retryable is True
    assert len(scripted.requests) == 1 and sleeper.delays == []
    (record,) = [json.loads(line) for line in (tmp_path / "generation-ledger.jsonl").read_text(encoding="utf-8").splitlines()]
    assert record["outcome"] == "invalid_output:wrong_shape"
    assert record["prompt_version"] == lesson_pipeline.PROMPT_VERSION


def test_archived_live_draft_with_the_previous_prompt_version_still_validates_and_imports():
    raw = LIVE.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == LIVE_SHA256
    data = json.loads(raw.decode("utf-8"))
    assert data["generation"]["prompt_version"] == PREVIOUS_PROMPT_VERSION != lesson_pipeline.PROMPT_VERSION
    draft = LessonDraft.model_validate(data)
    assert validate_draft(draft, load_registry(CONTENT)) == []
    app = client(ScriptedDeepSeek())
    checked = app.post("/api/drafts/validate", json={"draft": data, "review": None})
    assert checked.status_code == 200, checked.text
    assert checked.json()["valid"] is True and checked.json()["errors"] == []
    envelope = app.post("/api/export/json", json={"draft": data, "review": None})
    assert envelope.status_code == 200, envelope.text
    imported = app.post("/api/drafts/import", content=json.dumps(envelope.json(), ensure_ascii=False).encode("utf-8"))
    assert imported.status_code == 200, imported.text
    body = imported.json()
    assert body["valid"] is True and body["errors"] == [] and body["status"] == "draft"
    assert body["draft"] == draft.model_dump(mode="json")
    assert body["draft"]["generation"]["prompt_version"] == PREVIOUS_PROMPT_VERSION
    assert LIVE.read_bytes() == raw
