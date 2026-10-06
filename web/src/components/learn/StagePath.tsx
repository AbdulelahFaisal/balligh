import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { isLocale, libraryApi } from "@/lib/library";
import { cn } from "@/lib/utils";
import { LOCALE_NAMES } from "@/lib/types";
import { contextHref, entryKey, distinctKeys, firstUnread, useStagePath, type CompletionNotice, type StageEntry, type StagePath as Path } from "@/lib/stages";

function firstStageOf(path: Path, key: string, before: number): number {
  return path.stages.find((s) => s.order < before && s.entries.some((e) => entryKey(e) === key))?.order ?? before;
}

/** A display title from an actual published hadith translation in the reading language; fatwa titles come from the stage entry itself (AI-assisted). */
function useTranslatedTitle(entry: StageEntry, lang: string | null): { title: string; locale: string } | null {
  const [found, setFound] = useState<{ title: string; locale: string; key: string } | null>(null);
  const key = `${entry.source_id}|${lang ?? ""}`;
  const wanted = entry.collection === "hadith" && !!lang && lang !== "ar" && entry.languages.includes(lang);
  useEffect(() => {
    if (!wanted || !lang) return;
    const ac = new AbortController();
    libraryApi.hadith(entry.source_id, lang, ac.signal).then(
      (d) => {
        const title = d.translation_status === "available" ? d.translation?.title?.trim() : null;
        if (title && !ac.signal.aborted) setFound({ title, locale: lang, key });
      },
      () => undefined,
    );
    return () => ac.abort();
  }, [wanted, entry.source_id, lang, key]);
  return wanted && found && found.key === key ? found : null;
}

function Entry({ entry, stage, position, lang, path, read, onMark }: { entry: StageEntry; stage: number; position: number; lang: string | null; path: Path; read: boolean; onMark: (read: boolean) => void }) {
  const { t } = useTranslation();
  const names = entry.languages.filter(isLocale).map((l) => LOCALE_NAMES[l]);
  const machine =
    entry.collection === "fatwa" && Array.isArray(entry.machine_languages)
      ? entry.machine_languages.filter(isLocale).filter((l, i, all) => all.indexOf(l) === i && !entry.languages.includes(l))
      : [];
  const published = useTranslatedTitle(entry, lang);
  const machineTitle = lang && lang !== "ar" && machine.some((l) => l === lang) ? entry.translated_titles?.[lang] : null;
  const translated =
    published ?? (lang && typeof machineTitle === "string" && machineTitle.trim() ? { title: machineTitle.trim(), locale: lang } : null);
  return (
    <li className="step-card" data-testid="stage-entry" data-collection={entry.collection} data-id={entry.source_id} data-recap={entry.recap} data-read={read}>
      <span className="min-w-0 flex-1 space-y-2">
        {translated && (
          <span lang={translated.locale} dir="auto" className="block text-start font-semibold" data-testid="entry-translated-title" data-locale={translated.locale}>
            {translated.title}
          </span>
        )}
        <span lang="ar" dir="rtl" className={cn("quote-ar block text-start", translated ? "text-muted-foreground" : "font-semibold")} data-testid="entry-original-title">
          {entry.title}
        </span>
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge className="badge-teal">{t(`stages.collections.${entry.collection}`)}</Badge>
          {entry.recap && (
            <Badge className="badge-clay" data-testid="recap-badge">
              {t("stages.recap", { n: firstStageOf(path, entryKey(entry), stage) })}
            </Badge>
          )}
          <span data-testid="entry-languages">
            {entry.collection === "fatwa" && machine.length === 0 ? t("stages.arabicOnly") : t("stages.languages", { languages: names.join(" · ") })}
          </span>
          {machine.length > 0 && (
            <span data-testid="entry-machine-languages" data-locales={machine.join(" ")}>
              {t("stages.aiLanguages", { languages: machine.map((l) => LOCALE_NAMES[l]).join(" · ") })}
            </span>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-3">
          <Link to={contextHref(entry, stage, position, lang)} className="bl-btn bl-btn--quiet" data-testid="stage-entry-link">
            {t("stages.open")}
          </Link>
          <Button type="button" variant={read ? "default" : "outline"} aria-pressed={read} className="h-auto max-w-full whitespace-normal text-center" data-testid="mark-read" onClick={() => onMark(!read)}>
            {read ? t("stages.markedRead") : t("stages.markRead")}
          </Button>
        </span>
      </span>
    </li>
  );
}

function Support({ path }: { path: Path }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="human-support-title" className="surface surface-raised space-y-3 p-5" data-testid="human-support">
      <h3 id="human-support-title" className="text-lg font-bold">
        {t("stages.support.title")}
      </h3>
      <p>{t("stages.support.body")}</p>
      <p>
        <a href={path.human_support.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="bl-btn" data-testid="human-support-link">
          {t("stages.support.link")}
        </a>
      </p>
      <p className="text-sm text-muted-foreground" data-testid="human-support-faq">
        {t("stages.support.faq")}{" "}
        <cite dir="ltr" lang="en">
          {path.human_support.faq_url}
        </cite>
      </p>
      <p className="text-sm text-muted-foreground">{t("stages.support.note")}</p>
    </section>
  );
}

export function JustExploring() {
  const { t } = useTranslation();
  const { state } = useStagePath();
  const first = state.status === "ready" ? state.data.stages[0]?.entries[0] : undefined;
  if (!first) return null;
  return (
    <p>
      <Link to={first.href} className="bl-btn bl-btn--quiet" data-testid="just-exploring">
        {t("stages.exploring")}
      </Link>
    </p>
  );
}

export interface StageJourney {
  state: ReturnType<typeof useStagePath>["state"];
  retry: () => void;
  done: Set<string>;
  notice: CompletionNotice;
  mark: (key: string, read: boolean) => void;
  lang: string | null;
}

/** The one primary action of the Learn page: the first reading, in stage order, not yet explicitly marked as read. */
export function StageStart({ journey }: { journey: StageJourney }) {
  const { t } = useTranslation();
  const path = journey.state.status === "ready" ? journey.state.data : null;
  if (!path) return null;
  const next = firstUnread(path, journey.done);
  const started = distinctKeys(path).some((k) => journey.done.has(k));
  if (!next)
    return (
      <div className="space-y-2" data-testid="stage-start" data-state="complete">
        <p className="font-semibold">{t("stages.allRead")}</p>
        <Button asChild size="lg">
          <Link to="/learn?stage=end" data-testid="stage-start-link">
            {t("stages.end.title")}
          </Link>
        </Button>
      </div>
    );
  return (
    <div className="space-y-2" data-testid="stage-start" data-state={started ? "continue" : "start"} data-stage={next.stage.order} data-entry={next.index + 1} data-id={next.entry.source_id}>
      <p className="bl-eyebrow">{started ? t("stages.continueStage", { n: next.stage.order }) : t("stages.stage", { n: next.stage.order })}</p>
      <p className="bl-next-title" lang="ar" dir="rtl">
        <bdi>{next.entry.title}</bdi>
      </p>
      <Button asChild size="lg">
        <Link to={contextHref(next.entry, next.stage.order, next.index + 1, journey.lang)} data-testid="stage-start-link">
          {started ? t("stages.continue") : t("stages.start")}
        </Link>
      </Button>
    </div>
  );
}

export function StagePath({ journey }: { journey: StageJourney }) {
  const { t } = useTranslation();
  const { state, retry, done, notice, mark, lang } = journey;
  const path = state.status === "ready" ? state.data : null;
  const [params, setParams] = useSearchParams();
  const heading = useRef<HTMLHeadingElement>(null);
  const raw = params.get("stage");
  const total = path?.stages.length ?? 0;
  const current = raw === "end" ? "end" : Math.min(Math.max(Number(raw) || 1, 1), Math.max(total, 1));
  const moved = useRef(false);

  useEffect(() => {
    if (!moved.current) return;
    heading.current?.focus();
  }, [current]);

  if (state.status === "loading")
    return (
      <p role="status" className="text-muted-foreground">
        {t("stages.loading")}
      </p>
    );
  if (!path)
    return (
      <div role="alert" className="space-y-2" data-testid="stages-error">
        <p className="font-semibold">{t("stages.error")}</p>
        <Button variant="outline" onClick={retry}>
          {t("stages.retry")}
        </Button>
      </div>
    );

  const keys = distinctKeys(path);
  const readCount = keys.filter((k) => done.has(k)).length;
  const go = (to: number | "end") => {
    moved.current = true;
    const next = new URLSearchParams(params);
    next.set("stage", String(to));
    setParams(next, { preventScrollReset: true });
  };
  const nextAt = firstUnread(path, done);
  const stage = current === "end" ? null : path.stages[current - 1];

  return (
    <section aria-labelledby="stages-title" className="space-y-4" data-testid="stage-path" data-version={path.version} data-identity={path.identity}>
      <div className="space-y-2">
        <h2 id="stages-title" className="text-xl font-bold">
          {t("stages.title")}
        </h2>
        <p className="text-muted-foreground">{t("stages.intro")}</p>
      </div>
      {notice && (
        <p role="status" className="surface notice-clay px-3 py-2 text-sm" data-testid="completion-notice" data-notice={notice}>
          {t(`stages.storage.${notice}`)}
        </p>
      )}
      <p className="text-sm font-semibold text-muted-foreground" data-testid="completion-progress" aria-live="polite">
        {t("stages.progress", { done: readCount, total: keys.length })}
      </p>
      <nav aria-label={t("stages.nav")} data-testid="stage-nav">
        <ol className="flex flex-wrap gap-2">
          {path.stages.map((s) => {
            const stageKeys = [...new Set(s.entries.map(entryKey))];
            const stageDone = stageKeys.filter((k) => done.has(k)).length;
            return (
              <li key={s.key}>
                <Button
                  type="button"
                  variant={current === s.order ? "default" : "outline"}
                  aria-current={current === s.order ? "step" : undefined}
                  data-testid="stage-tab"
                  data-stage={s.order}
                  onClick={() => go(s.order)}
                  className="h-auto whitespace-normal text-start"
                >
                  <span>
                    {t("stages.stage", { n: s.order })}: {t(`stages.names.${s.key}`)}{" "}
                    <span className="text-xs">({stageDone}/{stageKeys.length})</span>
                  </span>
                </Button>
              </li>
            );
          })}
          <li>
            <Button type="button" variant={current === "end" ? "default" : "outline"} aria-current={current === "end" ? "step" : undefined} data-testid="stage-tab" data-stage="end" onClick={() => go("end")}>
              {t("stages.endNav")}
            </Button>
          </li>
        </ol>
      </nav>
      {stage ? (
        <section aria-labelledby="stage-heading" className="surface space-y-3 p-5" data-testid="stage-panel" data-stage={stage.order}>
          <p className="bl-eyebrow">{t("stages.stage", { n: stage.order })}</p>
          <h3 id="stage-heading" ref={heading} tabIndex={-1} className="text-lg font-bold">
            {t(`stages.names.${stage.key}`)}
          </h3>
          <ol className="space-y-3">
            {stage.entries.map((e, i) => (
              <Entry key={`${e.collection}-${e.source_id}-${i}`} entry={e} stage={stage.order} position={i + 1} lang={lang} path={path} read={done.has(entryKey(e))} onMark={(r) => mark(entryKey(e), r)} />
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-3" data-testid="stage-next">
            {nextAt ? (
              <Link to={contextHref(nextAt.entry, nextAt.stage.order, nextAt.index + 1, lang)} className="bl-btn bl-btn--quiet" data-testid="next-reading" data-id={nextAt.entry.source_id}>
                {t("stages.nextReading")}: <bdi lang="ar">{nextAt.entry.title}</bdi>
              </Link>
            ) : (
              <span data-testid="all-read">{t("stages.allRead")}</span>
            )}
            <Button type="button" size="lg" data-testid="next-stage" onClick={() => go(stage.order < total ? stage.order + 1 : "end")}>
              {stage.order < total ? t("stages.nextStage", { n: stage.order + 1 }) : t("stages.toEnd")}
            </Button>
          </div>
        </section>
      ) : (
        <section aria-labelledby="stage-heading" className="surface space-y-4 p-5" data-testid="stage-end">
          <h3 id="stage-heading" ref={heading} tabIndex={-1} className="text-lg font-bold">
            {t("stages.end.title")}
          </h3>
          <p data-testid="end-summary" data-complete={readCount === keys.length}>
            {readCount === keys.length ? t("stages.end.complete") : t("stages.end.partial", { done: readCount, total: keys.length })}
          </p>
          <div className="space-y-1">
            <h4 className="font-semibold">{t("stages.end.notCoveredTitle")}</h4>
            <ul className="list-disc space-y-1 ps-6" data-testid="not-covered">
              {path.not_covered.map((k) => (
                <li key={k}>{t(`stages.end.notCovered.${k}`)}</li>
              ))}
            </ul>
          </div>
          <Support path={path} />
        </section>
      )}
    </section>
  );
}
