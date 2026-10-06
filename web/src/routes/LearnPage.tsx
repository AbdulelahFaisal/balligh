import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { isLocale } from "@/lib/library";
import { useContinueReading } from "@/lib/reading";
import { ReadingStoreNotice } from "@/components/ReadingPlace";
import { cn } from "@/lib/utils";
import { JustExploring, StagePath, StageStart, type StageJourney } from "@/components/learn/StagePath";
import { contextHref, loadStagePath, nextPosition, parseStageContext, PATH_ID, useCompletion, useStagePath, type StagePath as StagePathData } from "@/lib/stages";

export type StepCollection = "quran" | "fatwa" | "hadith";

export interface FirstStep {
  order: number;
  collection: StepCollection;
  source_id: string;
  level: string;
  topic: string;
  languages: string[];
  caution: string | null;
  reason: string;
  title?: string;
  href?: string;
}

export interface TeacherContextEntry {
  collection: string;
  source_id: string;
  classification: string;
  reason: string;
  href?: string;
}

export interface LearnManifest {
  schema: string;
  version: string;
  basis: string;
  first_steps: FirstStep[];
  teacher_context: TeacherContextEntry[];
}

type ManifestState = { status: "loading" } | { status: "ready"; data: LearnManifest } | { status: "error" };

const PATHS: Record<StepCollection, string> = { quran: "quran", fatwa: "questions", hadith: "hadith" };

export const stepHref = (s: Pick<FirstStep, "collection" | "source_id">) =>
  `/library/${PATHS[s.collection]}/${encodeURIComponent(s.source_id)}`;

function isManifest(x: unknown): x is LearnManifest {
  if (!x || typeof x !== "object") return false;
  const m = x as LearnManifest;
  return (
    m.schema === "balligh.learn.v1" &&
    Array.isArray(m.first_steps) &&
    Array.isArray(m.teacher_context) &&
    m.first_steps.every(
      (s) =>
        s &&
        typeof s.source_id === "string" &&
        typeof s.order === "number" &&
        (s.collection === "quran" || s.collection === "fatwa" || s.collection === "hadith") &&
        Array.isArray(s.languages),
    ) &&
    m.teacher_context.every((e) => e && typeof e.source_id === "string" && typeof e.classification === "string")
  );
}

let cache: Promise<LearnManifest> | null = null;

export function loadManifest(): Promise<LearnManifest> {
  cache ??= fetch("/api/learn", { headers: { Accept: "application/json" } })
    .then(async (res) => {
      if (!res.ok) throw new Error(String(res.status));
      const data: unknown = await res.json();
      if (!isManifest(data)) throw new Error("invalid");
      return { ...data, first_steps: [...data.first_steps].sort((a, b) => a.order - b.order) };
    })
    .catch((e: unknown) => {
      cache = null;
      throw e;
    });
  return cache;
}

export function useLearnManifest(): { state: ManifestState; retry: () => void } {
  const [state, setState] = useState<ManifestState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    loadManifest().then(
      (data) => live && setState({ status: "ready", data }),
      () => live && setState({ status: "error" }),
    );
    return () => {
      live = false;
    };
  }, [nonce]);
  return { state, retry: () => setNonce((n) => n + 1) };
}

export function useTeacherContext(collection: "fatwa" | "hadith"): Map<string, TeacherContextEntry> {
  const { state } = useLearnManifest();
  const map = new Map<string, TeacherContextEntry>();
  if (state.status === "ready")
    for (const e of state.data.teacher_context) if (e.collection === collection) map.set(e.source_id, e);
  return map;
}

export function TeacherBadge({ entry }: { entry: TeacherContextEntry }) {
  const { t } = useTranslation();
  return (
    <Badge className="badge-clay" data-testid="teacher-badge" data-classification={entry.classification}>
      {t(`learn.teacher.badge.${entry.classification}`, { defaultValue: t("learn.teacher.badge.teacher_context") })}
    </Badge>
  );
}

export function TeacherNotice({ entry }: { entry: TeacherContextEntry }) {
  const { t } = useTranslation();
  return (
    <aside className="surface notice-clay space-y-2 p-4" data-testid="teacher-notice" data-classification={entry.classification}>
      <p className="flex flex-wrap items-center gap-2 font-semibold">
        <TeacherBadge entry={entry} />
        <span>{t("learn.teacher.notice")}</span>
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">{t("learn.teacher.reasonLabel")}</summary>
        <p lang="en" dir="ltr" className="mt-1 text-start">
          {entry.reason}
        </p>
      </details>
    </aside>
  );
}

export function CoverageLine() {
  const { t } = useTranslation();
  return (
    <div className="space-y-1 text-sm text-muted-foreground" data-testid="coverage-line">
      <p>{t("learn.coverage")}</p>
      <p>{t("learn.kinds")}</p>
    </div>
  );
}

export function LearnPage() {
  const { t, i18n } = useTranslation();
  const { state, retry } = useStagePath();
  const path = state.status === "ready" ? state.data : null;
  const { done, notice, mark } = useCompletion(path);
  const journey: StageJourney = { state, retry, done, notice, mark, lang: isLocale(i18n.language) ? i18n.language : null };
  const { state: cont } = useContinueReading();
  const canContinue = cont.status === "valid";

  return (
    <section className="mx-auto max-w-5xl space-y-8" data-testid="learn-page">
      <ReadingStoreNotice />
      <div className="bl-learn-hero">
        <div className="space-y-3">
          <h1 className="text-3xl font-bold leading-tight">{t("learn.page.title")}</h1>
          <p className="text-lg text-muted-foreground">{t("learn.page.intro")}</p>
          <JustExploring />
        </div>
        <div className="surface surface-raised bl-paper-stack space-y-4 p-5" data-testid="next-step-card">
          <StageStart journey={journey} />
          {path && <p className="text-sm text-muted-foreground">{t("learn.page.noQuiz")}</p>}
          {canContinue && (
            <div className="space-y-2 border-t pt-3" data-testid="continue">
              <p className="text-sm font-semibold text-muted-foreground">{t("learn.page.continueLabel")}</p>
              <p lang={cont.record.collection === "fatwa" ? "ar" : undefined} className="font-semibold">
                <bdi>{cont.record.title}</bdi>
              </p>
              <Button asChild variant="outline">
                <Link to={`${cont.record.href.split("#")[0]}#${cont.record.anchor}`} data-testid="continue-link">
                  {t("learn.page.continue")}
                </Link>
              </Button>
            </div>
          )}
          {cont.status === "stale" && (
            <p className="text-sm text-muted-foreground" data-testid="continue-stale">
              {t("learn.page.continueStale")}
            </p>
          )}
        </div>
      </div>
      <StagePath journey={journey} />
      <p className="flex flex-wrap gap-x-6 gap-y-2" data-testid="learn-secondary">
        <Link to="/library" className="bl-btn bl-btn--quiet">
          {t("learn.home.libraryCta")}
        </Link>
        <Link to="/setup" className="bl-btn bl-btn--quiet">
          {t("learn.home.prepareCta")}
        </Link>
      </p>
      <CoverageLine />
    </section>
  );
}

/** Reader bar shown only when a reader was opened from the stage path with a valid context. */
export function FirstStepBar() {
  const { t } = useTranslation();
  const location = useLocation();
  const onReader = /^\/library\/(quran|questions|hadith)\/[^/]+$/.test(location.pathname);
  const params = new URLSearchParams(location.search);
  const wanted = onReader && params.get("path") === PATH_ID;
  const [path, setPath] = useState<StagePathData | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    loadStagePath().then(
      (data) => live && setPath(data),
      () => live && setPath(null),
    );
    return () => {
      live = false;
    };
  }, [wanted]);
  if (!wanted || !path) return null;
  const at = parseStageContext(path, params, location.pathname);
  if (!at) return null;
  const next = nextPosition(path, at);
  const lang = params.get("lang");
  return (
    <nav aria-label={t("stages.title")} className="surface surface-raised mx-auto mt-8 max-w-3xl space-y-3 p-4" data-testid="stage-bar" data-stage={at.stage.order} data-entry={at.index + 1}>
      <p className="text-sm font-semibold text-muted-foreground" data-testid="stage-position">
        {t("stages.position", { n: at.stage.order, i: at.index + 1, total: at.stage.entries.length })}
      </p>
      <div className={cn("flex flex-wrap items-center gap-3")}>
        {next ? (
          <Button asChild size="lg" className="h-auto max-w-full whitespace-normal text-center">
            <Link to={contextHref(next.entry, next.stage.order, next.index + 1, lang)} data-testid="stage-next-link" data-id={next.entry.source_id} data-stage={next.stage.order} data-entry={next.index + 1}>
              {t("stages.nextReading")}: <bdi lang="ar">{next.entry.title}</bdi>
            </Link>
          </Button>
        ) : (
          <Button asChild size="lg">
            <Link to="/learn?stage=end" data-testid="stage-end-link">
              {t("stages.toEnd")}
            </Link>
          </Button>
        )}
        <Link to={`/learn?stage=${at.stage.order}`} className="inline-flex min-h-11 items-center px-2 underline-offset-4 hover:underline" data-testid="back-to-stage">
          {t("stages.backToStage", { n: at.stage.order })}
        </Link>
      </div>
    </nav>
  );
}
