import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { safeSourceUrl } from "@/lib/safeUrl";
import { dirOf, type LessonCard, type LessonDraft, type SourceRecord } from "@/lib/types";
import { useWorkspace, type DisplayStatus } from "@/lib/workspace";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { highlightSegments } from "@/lib/spans";
import { isTeacherRecord, sourcesForDraft, sourceTextFor, teacherRecord } from "@/lib/teacherSource";
import { cn } from "@/lib/utils";

let sourcesCache: Promise<SourceRecord[]> | null = null;

export function useSources(): Record<string, SourceRecord> {
  const [map, setMap] = useState<Record<string, SourceRecord>>({});
  useEffect(() => {
    sourcesCache ??= api.sources().catch((e) => {
      sourcesCache = null;
      throw e;
    });
    sourcesCache.then((list) => setMap(Object.fromEntries(list.map((s) => [s.id, s])))).catch(() => undefined);
  }, []);
  return map;
}

const STATUS_STYLE: Record<NonNullable<DisplayStatus>, string> = {
  draft: "bg-muted text-foreground",
  needs_correction: "bg-accent text-accent-foreground",
  stale: "bg-accent text-accent-foreground",
  acknowledged_by_user: "bg-primary text-primary-foreground",
  team_published: "bg-foreground text-background",
  unverified: "bg-accent text-accent-foreground",
};

export function StatusBadge({ status }: { status: DisplayStatus }) {
  const { t } = useTranslation();
  if (!status)
    return (
      <Badge className="bg-muted" data-testid="review-status" data-status="checking">
        {t("status.checking")}
      </Badge>
    );
  return (
    <Badge className={STATUS_STYLE[status]} data-testid="review-status" data-status={status}>
      {t(`status.${status}`)}
    </Badge>
  );
}

export function QuoteBlock({ text, lang }: { text: string; lang: string }) {
  return (
    <blockquote
      lang={lang}
      dir={dirOf(lang)}
      className="quote-ar bl-quote mb-2"
    >
      {text}
    </blockquote>
  );
}

export function SourceCard({ card, draft, status }: { card: LessonCard; draft: LessonDraft; status: DisplayStatus }) {
  const { t } = useTranslation();
  const sources = sourcesForDraft(draft, useSources());
  const spans = draft.spans.filter((s) => card.source_span_ids.includes(s.id));
  return (
    <div className="mt-3 border-t border-dashed border-border pt-2 text-sm text-muted-foreground" data-testid="source-card">
      {spans.map((sp) => {
        const rec = sources[sp.source_id];
        const href = safeSourceUrl(rec?.canonical_url);
        return (
          <p key={sp.id}>
            <span className="font-semibold text-foreground">{t("source.label")}: </span>
            <bdi>{rec?.title || (isTeacherRecord(rec) ? t("teach.teacherTitleFallback") : sp.source_id)}</bdi>
            {" · "}
            {t("source.chars", { start: sp.start_offset, end: sp.end_offset })}
            {" · "}
            {isTeacherRecord(rec) ? (
              <span data-testid="teacher-source-label">{t("teach.teacherLabel")}</span>
            ) : href ? (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                {t("source.open")}
              </a>
            ) : (
              <span>{t("source.local")}</span>
            )}
            {rec?.is_test_data && (
              <>
                {" · "}
                <span className="font-semibold text-accent">{t("source.test")}</span>
              </>
            )}
          </p>
        );
      })}
      <p>
        <span className="font-semibold text-foreground">{t("source.type")}: </span>
        {t(`deriv.${card.derivation}`)}
        {" · "}
        <span className="font-semibold text-foreground">{t("source.review")}: </span>
        {status ? t(`status.${status}`) : t("status.checking")}
      </p>
    </div>
  );
}

export function ImportButton({ variant = "outline" }: { variant?: "outline" | "default" }) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const input = useRef<HTMLInputElement>(null);
  const state = ws.importState;
  const busy = state.phase !== "idle";

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid="import-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) ws.importFile(f);
        }}
      />
      <Button
        variant={variant}
        disabled={busy}
        aria-busy={state.phase === "checking" && state.kind === "file"}
        onClick={() => input.current?.click()}
      >
        {state.phase === "checking" && state.kind === "file" ? t("import.checking") : t("preview.import")}
      </Button>
    </>
  );
}

function SourceLine({ record, sourceId }: { record: SourceRecord | undefined; sourceId: string }) {
  const { t } = useTranslation();
  const href = safeSourceUrl(record?.canonical_url);
  if (record && isTeacherRecord(record))
    return (
      <>
        <bdi>{record.title || t("teach.teacherTitleFallback")}</bdi>
        {" · "}
        <span data-testid="teacher-source-label">{t("teach.teacherLabel")}</span>
        {record.provenance_note && (
          <>
            {" · "}
            {t("teach.teacherReference")}: <bdi>{record.provenance_note}</bdi>
          </>
        )}
      </>
    );
  return (
    <>
      <bdi>{record?.title ?? sourceId}</bdi>
      {" · "}
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">
          {t("source.open")}
        </a>
      ) : (
        <span>{t("source.local")}</span>
      )}
      {record?.is_test_data && (
        <>
          {" · "}
          <span className="font-semibold text-accent">{t("source.test")}</span>
        </>
      )}
    </>
  );
}

export function EvidenceQuotes({ draft, spanIds, testId }: { draft: LessonDraft; spanIds: string[]; testId?: string }) {
  const { t } = useTranslation();
  const sources = sourcesForDraft(draft, useSources());
  const spans = spanIds.flatMap((id) => draft.spans.filter((s) => s.id === id));
  if (spans.length === 0) return <p className="text-sm font-semibold">{t("evidence.none")}</p>;
  return (
    <ul className="space-y-2" data-testid={testId}>
      {spans.map((sp) => (
        <li key={sp.id} data-span-id={sp.id}>
          <QuoteBlock text={sp.exact_text} lang={sources[sp.source_id]?.language ?? "ar"} />
          <p className="text-sm text-muted-foreground">
            <SourceLine record={sources[sp.source_id]} sourceId={sp.source_id} />
            {" · "}
            {t("source.chars", { start: sp.start_offset, end: sp.end_offset })}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function SourceLevelRefs({ sourceIds }: { sourceIds: string[] }) {
  const { t } = useTranslation();
  const sources = sourcesForDraft(useWorkspace().draft, useSources());
  return (
    <div className="text-sm text-muted-foreground" data-testid="term-refs">
      {sourceIds.map((id) => (
        <p key={id}>
          <span className="font-semibold text-foreground">{t("evidence.sourceLevel")}: </span>
          <SourceLine record={sources[id]} sourceId={id} />
        </p>
      ))}
      <p>{t("evidence.sourceLevelHelp")}</p>
    </div>
  );
}

type LoadedSource =
  | { id: string; ok: true; record: SourceRecord; text: string | null }
  | { id: string; ok: false };

export function OriginalText({ draft, activeSpanIds }: { draft: LessonDraft; activeSpanIds: string[] }) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<LoadedSource | null>(null);
  const [attempt, setAttempt] = useState(0);
  const sourceId = draft.source_ids[0];
  const embedded = sourceTextFor(draft, sourceId);
  const teacher = draft.teacher_source;
  useEffect(() => {
    if (embedded !== null && teacher) {
      setLoaded({ id: sourceId, ok: true, record: teacherRecord(teacher), text: embedded });
      return;
    }
    let current = true;
    api.source(sourceId).then(
      (s) => {
        if (current) setLoaded({ id: sourceId, ok: true, record: s.record, text: s.text });
      },
      () => {
        if (current) setLoaded({ id: sourceId, ok: false });
      },
    );
    return () => {
      current = false;
    };
  }, [sourceId, attempt, embedded, teacher]);
  const shown = loaded?.id === sourceId ? loaded : null;
  const spans = draft.spans.filter((s) => s.source_id === sourceId);
  const original =
    shown?.ok &&
    shown.text !== null &&
    spans.every((s) => s.source_version === shown.record.source_version && s.source_sha256 === shown.record.content_sha256)
      ? { record: shown.record, text: shown.text }
      : null;
  const state = original ? "ready" : !shown ? "loading" : shown.ok ? "unavailable" : "failed";
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]" data-testid="original" data-source-id={sourceId} data-state={state}>
      <p aria-live="polite" className="text-sm text-muted-foreground" data-testid="original-status">
        {state === "loading" ? t("review.originalLoading") : ""}
      </p>
      {state === "failed" && (
        <div role="alert" className="text-sm" data-testid="original-failed">
          <p>{t("review.originalFailed")}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => setAttempt((n) => n + 1)}>
            {t("source.reload")}
          </Button>
        </div>
      )}
      {state === "unavailable" && (
        <p role="alert" className="text-sm font-semibold" data-testid="original-unavailable">
          {t("review.originalUnavailable")}
        </p>
      )}
      {original && (
        <>
          <p className="mb-2 text-sm text-muted-foreground [overflow-wrap:anywhere]" data-testid="original-meta">
            <bdi>{original.record.title || t("teach.teacherTitleFallback")}</bdi>
            {isTeacherRecord(original.record) && (
              <>
                {" · "}
                <span data-testid="teacher-source-label">{t("teach.teacherLabel")}</span>
              </>
            )}
          </p>
          {isTeacherRecord(original.record) && original.record.provenance_note && (
            <p className="mb-2 text-sm text-muted-foreground [overflow-wrap:anywhere]" data-testid="original-reference">
              {t("teach.teacherReference")}: <bdi>{original.record.provenance_note}</bdi>
            </p>
          )}
          <details className="mb-2 text-xs text-muted-foreground" data-testid="original-technical">
            <summary className="cursor-pointer">{t("teach.technical")}</summary>
            <p className="[overflow-wrap:anywhere]">
              {t("teach.version")}: {original.record.source_version}
            </p>
            <p className="[overflow-wrap:anywhere]">
              {t("teach.fingerprint")}: {original.record.content_sha256}
            </p>
          </details>
          <p
            lang={original.record.language}
            dir={dirOf(original.record.language)}
            className="quote-ar bl-source-text"
            data-testid="original-text"
          >
            {highlightSegments(
              original.text,
              spans.map((s) => ({ id: s.id, start: s.start_offset, end: s.end_offset })),
            ).map((p, i) =>
              p.id ? (
                <mark
                  key={i}
                  data-span-id={p.id}
                  data-active={activeSpanIds.includes(p.id)}
                  tabIndex={activeSpanIds.includes(p.id) ? -1 : undefined}
                  className={cn(
                    "rounded px-0.5 text-foreground",
                    activeSpanIds.includes(p.id) ? "bl-mark bl-mark--active" : "bl-mark",
                  )}
                >
                  {p.text}
                </mark>
              ) : (
                <span key={i}>{p.text}</span>
              ),
            )}
          </p>
        </>
      )}
    </div>
  );
}
