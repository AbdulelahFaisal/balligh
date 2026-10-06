import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ImportButton, useSources } from "@/components/lesson";
import { TeacherText } from "@/components/teacher/TeacherText";
import { api, ApiError, type ExampleSummary, type Health } from "@/lib/api";
import { dirOf, LOCALE_NAMES, type LessonDraft, type Level, type Locale, type SourceRecord } from "@/lib/types";
import {
  forCurrentOptions,
  optionKey,
  useGeneration,
  type GenerationOptions,
  type GenerationState,
} from "@/lib/useGeneration";
import { useWorkspace } from "@/lib/workspace";

const GENERATION_LOCALES: Locale[] = ["en", "ur", "zh-Hans", "id", "bn", "fr"];

const ERROR_KEYS: Record<string, string> = {
  not_configured: "gen.error.not_configured",
  busy: "gen.error.busy",
  duplicate_request: "gen.error.duplicate_request",
  unknown_source: "gen.error.stale_source",
  stale_source: "gen.error.stale_source",
  unsupported_source: "gen.error.unsupported",
  unsupported_locale: "gen.error.unsupported",
  source_too_long: "gen.error.unsupported",
  source_too_fragmented: "gen.error.unsupported",
  provider_auth: "gen.error.provider_auth",
  provider_balance: "gen.error.provider_balance",
  provider_rejected: "gen.error.provider_rejected",
  provider_busy: "gen.error.provider_busy",
  provider_timeout: "gen.error.provider_timeout",
  provider_network: "gen.error.provider_network",
  provider_unexpected: "gen.error.provider_unexpected",
  invalid_output: "gen.error.invalid_output",
  insufficient_context: "gen.error.insufficient_context",
  quran_quotation: "teach.error.quran",
  invalid_teacher_source: "teach.error.generic",
};

const errorKey = (e: ApiError) => (e.status === 0 ? "gen.error.network" : (e.code && ERROR_KEYS[e.code]) || "gen.error.generic");

const radioCard =
  "flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary has-[:checked]:border-primary has-[:checked]:ring-1 has-[:checked]:ring-primary has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring";

function useElapsedSeconds(since: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.round((now - since) / 1000));
}

function wordCount(text: string) {
  return text.split(/\s+/).filter(Boolean).length;
}

type Preview =
  | { id: string; state: "loading" }
  | { id: string; state: "ready"; record: SourceRecord; text: string | null }
  | { id: string; state: "failed" };

const sameSource = (a: SourceRecord, b: SourceRecord) =>
  a.id === b.id && a.source_version === b.source_version && a.content_sha256 === b.content_sha256;

type LessonSource = SourceRecord & {
  library_record_id?: string | null;
  library_collection?: "fatwa" | "hadith" | null;
  hadith_attribution?: string | null;
  hadith_grade?: string | null;
  external_check?: string | null;
};

const isReal = (s: LessonSource) => !s.is_test_data && !!s.library_record_id && !!s.canonical_url;

function SourceOption({ s, checked, onSelect }: { s: LessonSource; checked: boolean; onSelect: () => void }) {
  const { t } = useTranslation();
  const real = isReal(s);
  return (
    <label className={radioCard} data-testid={`source-option-${s.id}`}>
      <input type="radio" name="source" className="mt-1.5 size-4 shrink-0 accent-primary" checked={checked} onChange={onSelect} />
      <span className="min-w-0">
        <bdi className="font-medium">{s.title}</bdi>
        <span className="block text-sm text-muted-foreground">
          {real ? (
            <>
              {t(`teach.kind.${s.kind}`)} · <bdi>{s.publisher}</bdi>
            </>
          ) : (
            <>
              {s.local_reference ? t("source.local") : null}
              {s.is_test_data ? ` · ${t("source.test")}` : null}
            </>
          )}
        </span>
      </span>
    </label>
  );
}

function GenerationStatus({
  state,
  draftTitle,
  onConfirm,
  onDismiss,
  onCancel,
  onRetry,
}: {
  state: GenerationState;
  draftTitle: string;
  onConfirm: (o: GenerationOptions) => void;
  onDismiss: () => void;
  onCancel: () => void;
  onRetry: (o: GenerationOptions) => void;
}) {
  const { t } = useTranslation();
  const seconds = useElapsedSeconds(state.phase === "running" ? state.startedAt : null);
  if (state.phase === "idle") return null;
  if (state.phase === "confirm")
    return (
      <div className="rounded-lg border-2 border-accent-soft bg-background p-3" role="alertdialog" aria-labelledby="replace-title" data-testid="gen-confirm">
        <p id="replace-title" className="font-semibold">
          {t("gen.replaceTitle")}
        </p>
        <p className="mt-1 text-sm">{t("gen.replaceBody", { title: draftTitle })}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => onConfirm(state.options)}>{t("gen.replaceConfirm")}</Button>
          <Button variant="outline" onClick={onDismiss}>
            {t("gen.keep")}
          </Button>
        </div>
      </div>
    );
  if (state.phase === "running")
    return (
      <div className="rounded-lg border border-primary bg-background p-3" role="status" data-testid="gen-running">
        <p className="font-semibold">{t("gen.working", { seconds })}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t("gen.workingHelp")}</p>
        <Button variant="outline" size="sm" className="mt-2" onClick={onCancel}>
          {t("gen.cancel")}
        </Button>
      </div>
    );
  if (state.phase === "cancelled" || state.phase === "discarded")
    return (
      <p className="rounded-lg border border-border bg-background p-3 text-sm" role="status" data-testid={`gen-${state.phase}`}>
        {t(state.phase === "cancelled" ? "gen.cancelled" : "gen.discarded")}
      </p>
    );
  const { error } = state;
  return (
    <div className="rounded-lg border-2 border-accent bg-background p-3" role="alert" data-testid="gen-failed" data-code={error.code ?? ""}>
      <p>{t(errorKey(error))}</p>
      {error.diagnosticId && (
        <p className="mt-1 text-xs text-muted-foreground" dir="ltr">
          {t("gen.reference", { id: error.diagnosticId })}
        </p>
      )}
      {error.retryable && (
        <Button variant="outline" size="sm" className="mt-2" onClick={() => onRetry(state.options)}>
          {t("gen.retry")}
        </Button>
      )}
    </div>
  );
}

export function SetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const ws = useWorkspace();
  const [params] = useSearchParams();
  const linked = params.get("source");
  const sources = Object.values(useSources()) as LessonSource[];
  const realSources = sources.filter(isReal);
  const technical = sources.filter((s) => !isReal(s));
  const firstId = realSources[0]?.id ?? technical[0]?.id ?? "";
  const loaded = sources.length > 0;
  const fallback = loaded && realSources.length === 0;
  const [examples, setExamples] = useState<ExampleSummary[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [sourceId, setSourceId] = useState<string>("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [locale, setLocale] = useState<Locale>("en");
  const [level, setLevel] = useState<Level>("foundational");
  const [mode, setMode] = useState<"text" | "library">(linked !== null ? "library" : "text");
  const [teacherOptions, setTeacherOptions] = useState<{ options: GenerationOptions; revision: string } | null>(null);
  const [teacherRevision, setTeacherRevision] = useState("");
  useEffect(() => {
    if (linked !== null) setMode("library");
  }, [linked]);

  const onReady = useCallback(
    (_draft: LessonDraft) => {
      ws.setNotice(t("gen.ready"));
      navigate("/review");
    },
    [navigate, t, ws],
  );
  const generation = useGeneration(onReady);

  useEffect(() => {
    api.examples().then(setExamples).catch(() => setExamples([]));
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);
  useEffect(() => {
    if (!loaded) return;
    if (linked !== null) setSourceId(linked);
    else setSourceId((cur) => cur || firstId);
  }, [loaded, linked, firstId]);
  const known = sources.some((s) => s.id === sourceId);
  const linkMissing = loaded && linked !== null && sourceId === linked && !known;
  useEffect(() => {
    if (!sourceId || !known) return;
    let current = true;
    setPreview({ id: sourceId, state: "loading" });
    api.source(sourceId).then(
      (s) => {
        if (current) setPreview({ id: sourceId, state: "ready", record: s.record, text: s.text });
      },
      () => {
        if (current) setPreview({ id: sourceId, state: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [sourceId, previewAttempt, known]);

  const source: LessonSource | undefined = sources.find((s) => s.id === sourceId);
  const shown = source && preview?.id === source.id ? preview : null;
  const verified =
    source && shown?.state === "ready" && shown.text !== null && sameSource(shown.record, source)
      ? { record: shown.record, text: shown.text }
      : null;
  const previewState = verified
    ? "ready"
    : !shown || shown.state === "loading"
      ? "loading"
      : shown.state === "failed"
        ? "failed"
        : "unavailable";
  const example = examples.find((e) => e.target_locale === locale && e.source_ids.includes(sourceId));
  const configured = health?.generation.configured === true;
  const options: GenerationOptions | null = verified
    ? {
        sourceId: verified.record.id,
        sourceVersion: verified.record.source_version,
        sourceSha256: verified.record.content_sha256,
        locale,
        level,
      }
    : null;
  // G5B-R01: a pending confirmation or retry belongs to the exact form it was created from.
  const teacherKey = teacherOptions && teacherOptions.revision === teacherRevision ? optionKey(teacherOptions.options) : null;
  const currentKey = mode === "text" ? teacherKey : optionKey(options);
  const { syncOptions } = generation;
  useEffect(() => {
    syncOptions(currentKey);
  }, [currentKey, syncOptions]);
  const genState = forCurrentOptions(generation.state, currentKey);
  const running = genState.phase === "running";

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">{mode === "text" ? t("teach.prepareTitle") : t("setup.title")}</h1>
      {ws.draft && (
        <Card className="flex flex-wrap items-center gap-3">
          <p className="me-auto">{t("setup.current")}</p>
          <Button variant="outline" onClick={() => navigate("/review")}>
            {t("setup.continue")}
          </Button>
        </Card>
      )}
      {mode === "text" && (
        <TeacherText
          locale={locale}
          onLocale={setLocale}
          level={level}
          onLevel={setLevel}
          configured={configured}
          running={running}
          onLibrary={() => setMode("library")}
          onRevision={setTeacherRevision}
          onCreate={(o) => {
            setTeacherOptions({ options: o, revision: teacherRevision });
            generation.start(o, ws.draft !== null);
          }}
          status={
            <GenerationStatus
              state={genState}
              draftTitle={ws.draft?.title ?? ""}
              onConfirm={(o) => void generation.run(o)}
              onDismiss={generation.dismiss}
              onCancel={generation.cancel}
              onRetry={(o) => void generation.run(o)}
            />
          }
        />
      )}
      {mode === "library" && (
        <p>
          <button type="button" className="text-sm underline" data-testid="text-toggle" disabled={running} onClick={() => setMode("text")}>
            {t("teach.ownText")}
          </button>
        </p>
      )}
      {mode === "library" && (
      <div className="bl-prepare-grid grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <Card className="space-y-3">
          <fieldset disabled={running}>
            <legend className="font-semibold">{t("setup.source")}</legend>
            <p className="mb-2 text-sm text-muted-foreground">{t("setup.sourceHelp")}</p>
            {realSources.length > 0 && (
              <div className="space-y-2" data-testid="real-sources">
                <h3 className="text-sm font-semibold">{t("teach.realTitle")}</h3>
                <p className="text-sm text-muted-foreground">{t("teach.realHelp")}</p>
                {realSources.map((s) => (
                  <SourceOption key={s.id} s={s} checked={sourceId === s.id} onSelect={() => setSourceId(s.id)} />
                ))}
              </div>
            )}
            <div className="mt-4 space-y-2" data-testid="technical-sources">
              <h3 className="text-sm font-semibold">{t("teach.technicalTitle")}</h3>
              <p className="text-sm text-muted-foreground">{t("teach.technicalHelp")}</p>
              {fallback && (
                <p role="status" className="rounded-md border border-border bg-background p-2 text-sm font-semibold" data-testid="source-fallback">
                  {t("teach.fallbackNote")}
                </p>
              )}
              {technical.map((s) => (
                <SourceOption key={s.id} s={s} checked={sourceId === s.id} onSelect={() => setSourceId(s.id)} />
              ))}
            </div>
          </fieldset>
          {linkMissing && (
            <div role="alert" className="rounded-md border-2 border-accent bg-background p-3 text-sm" data-testid="source-unsupported">
              <p className="font-semibold">{t("teach.unsupportedTitle")}</p>
              <p className="mt-1">
                {t("teach.unsupported")} <bdi dir="ltr">{linked}</bdi>
              </p>
            </div>
          )}
        </Card>

        <Card className="bl-prepare-preview space-y-3">
          {source && isReal(source) && (
            <div className="space-y-1 text-sm" data-testid="source-meta">
              <p>
                {t(`teach.kind.${source.kind}`)} · <bdi>{source.publisher}</bdi>
              </p>
              {source.kind === "hadith" && (
                <p>
                  <bdi>{source.hadith_attribution}</bdi> · {t("teach.grade")} <bdi>{source.hadith_grade}</bdi>
                </p>
              )}
              {source.external_check && <p className="text-muted-foreground">{source.external_check}</p>}
              <a
                href={source.canonical_url ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-primary underline"
                data-testid="source-link"
              >
                {t("teach.openRecord")}
              </a>
              <p className="font-semibold" data-testid="source-ai-note">
                {t("teach.aiNote")}
              </p>
            </div>
          )}
          {source && (
            <div data-testid="source-preview" data-source-id={source.id} data-state={previewState}>
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="font-semibold">{t("setup.preview")}</h2>
                {verified && (
                  <span className="text-sm text-muted-foreground">
                    {t("setup.words", { count: wordCount(verified.text) })}
                  </span>
                )}
              </div>
              <p aria-live="polite" className="text-sm text-muted-foreground" data-testid="source-status">
                {previewState === "loading" ? t("setup.previewLoading") : ""}
              </p>
              {verified && (
                <p
                  lang={verified.record.language}
                  dir={dirOf(verified.record.language)}
                  tabIndex={0}
                  className="quote-ar mt-2 max-h-96 overflow-auto whitespace-pre-line rounded-md border-s-4 border-primary bg-background px-3 py-2 text-lg"
                  data-testid="source-text"
                >
                  {verified.text}
                </p>
              )}
              {previewState === "failed" && (
                <div role="alert" className="mt-2 rounded-md border-2 border-accent bg-background p-3 text-sm" data-testid="source-failed">
                  <p>{t("setup.previewFailed")}</p>
                  <Button variant="outline" size="sm" className="mt-2" onClick={() => setPreviewAttempt((n) => n + 1)}>
                    {t("source.reload")}
                  </Button>
                </div>
              )}
              {previewState === "unavailable" && (
                <p role="alert" className="mt-2 text-sm font-semibold" data-testid="source-unavailable">
                  {t("setup.previewUnavailable")}
                </p>
              )}
            </div>
          )}
        </Card>

        <Card className="space-y-4">
          <label className="block">
            <span className="font-semibold">{t("setup.locale")}</span>
            <select
              className="mt-1 block min-h-10 w-full rounded-md border border-input bg-card px-2"
              value={locale}
              disabled={running}
              onChange={(e) => setLocale(e.target.value as Locale)}
            >
              {GENERATION_LOCALES.map((l) => (
                <option key={l} value={l} lang={l}>
                  {LOCALE_NAMES[l]}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-sm text-muted-foreground">{t("setup.localeHelp")}</span>
          </label>
          <fieldset disabled={running}>
            <legend className="font-semibold">{t("setup.level")}</legend>
            <div className="mt-1 grid gap-2 sm:grid-cols-2">
              {(["foundational", "detailed"] as const).map((l) => (
                <label key={l} className={radioCard}>
                  <input
                    type="radio"
                    name="level"
                    className="mt-1.5 size-4 shrink-0 accent-primary"
                    checked={level === l}
                    onChange={() => setLevel(l)}
                  />
                  <span>
                    <span className="font-medium">{t(`level.${l}`)}</span>
                    <span className="block text-sm text-muted-foreground">{t(`level.${l}Help`)}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-sm text-muted-foreground">{t("setup.generateHint")}</p>
            <Button
              size="lg"
              className="w-full sm:w-auto"
              disabled={!configured || !options || running || linkMissing}
              aria-describedby={!configured ? "generate-off" : !options ? "generate-wait" : undefined}
              data-testid="generate"
              onClick={() => options && generation.start(options, ws.draft !== null)}
            >
              {t("setup.generate")}
            </Button>
            {health && !configured && (
              <p id="generate-off" className="text-sm font-semibold" data-testid="generate-off">
                {t("setup.generateOff")}
              </p>
            )}
            {configured && !options && !running && !linkMissing && (
              <p id="generate-wait" className="text-sm" data-testid="generate-wait">
                {t("setup.generateWait")}
              </p>
            )}
            <div aria-live="polite">
              <GenerationStatus
                state={genState}
                draftTitle={ws.draft?.title ?? ""}
                onConfirm={(o) => void generation.run(o)}
                onDismiss={generation.dismiss}
                onCancel={generation.cancel}
                onRetry={(o) => void generation.run(o)}
              />
            </div>
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <h2 className="font-semibold">{t("setup.fixtureTitle")}</h2>
            {example && level === "foundational" ? (
              <Button
                variant="outline"
                disabled={running || ws.importState.phase !== "idle"}
                aria-busy={ws.importState.phase === "checking" && ws.importState.kind === "example"}
                onClick={() => ws.openExample(example.id, "/review")}
              >
                {t("setup.open")}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">{t("setup.noFixture")}</p>
            )}
          </div>
        </Card>
      </div>
      )}
      <Card className="flex flex-wrap items-center gap-3">
        <p className="me-auto">{t("setup.import")}</p>
        <ImportButton />
      </Card>
    </section>
  );
}
