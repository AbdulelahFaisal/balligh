import argparse
import asyncio
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from balligh.config import load_settings
from balligh.ledger import Ledger
from balligh.lesson_pipeline import GenerateRequest, GenerationError, GenerationService, load_glossary
from balligh.sources import load_registry


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Live DeepSeek generation through the real pipeline. Spends money.")
    parser.add_argument("--source", action="append", required=True, help="registered source id (repeatable)")
    parser.add_argument("--locale", action="append", required=True, help="target locale (repeatable)")
    parser.add_argument("--level", choices=["foundational", "detailed"], default="foundational")
    parser.add_argument("--out", type=Path, help="directory for the generated drafts")
    parser.add_argument("--confirm-live", action="store_true", help="required: acknowledges that real calls are made")
    return parser.parse_args()


async def one(service: GenerationService, source_id: str, locale: str, level: str, out: Path | None) -> dict:
    record = service.registry.sources[source_id]
    request = GenerateRequest(
        request_id=str(uuid.uuid4()),
        source_id=source_id,
        source_version=record.source_version,
        source_sha256=record.content_sha256,
        target_locale=locale,
        level=level,
    )
    summary = {"request_id": request.request_id, "source_id": source_id, "locale": locale, "level": level}
    try:
        draft = await service.run(service.prepare(request))
    except GenerationError as e:
        summary.update(outcome=e.code, diagnostic_id=e.diagnostic_id)
        return summary
    usage = draft.generation.usage.model_dump() if draft.generation.usage else None
    summary.update(
        outcome="success",
        title=draft.title,
        latency_ms=draft.generation.latency_ms,
        returned_model=draft.generation.returned_model,
        usage=usage,
        terms=len(draft.terms),
        findings=draft.validation_findings,
    )
    if out:
        out.mkdir(parents=True, exist_ok=True)
        path = out / f"live-draft-{locale}-{level}-{source_id}-{request.request_id[:8]}.json"
        path.write_text(json.dumps(draft.model_dump(mode="json"), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        summary["draft_file"] = path.name
    return summary


async def main() -> None:
    args = parse_args()
    if not args.confirm_live:
        raise SystemExit("Refusing to call the provider without --confirm-live.")
    settings = load_settings()
    if not settings.generation_configured:
        raise SystemExit("DEEPSEEK_API_KEY is not set in the process environment or app/.env.")
    service = GenerationService(
        settings=settings,
        registry=load_registry(settings.content_dir),
        glossary=load_glossary(settings.content_dir),
        ledger=Ledger(settings.ledger_dir) if settings.ledger_dir else None,
    )
    jobs = [(s, loc) for s in args.source for loc in args.locale]
    gate = asyncio.Semaphore(settings.generation.max_in_flight)

    async def guarded(source_id: str, locale: str) -> dict:
        async with gate:
            return await one(service, source_id, locale, args.level, args.out)

    for summary in await asyncio.gather(*(guarded(s, loc) for s, loc in jobs)):
        print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
