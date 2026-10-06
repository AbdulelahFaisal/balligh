import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  anchorFromHash,
  fatwaSource,
  fatwaVersion,
  hadithSource,
  hadithVersion,
  recordOpened,
  restoreDecision,
  useReadingState,
  type CurrentSource,
  type ReadingCollection,
  type ReadingLocation,
  type ReadingRecord,
} from "@/lib/reading";
import { ReadingStoreNotice, SavePlaceButton, useRestoreAnchor } from "@/components/ReadingPlace";
import { useAssistant, useAssistantScope } from "@/components/assistant/AssistantProvider";
import { TeacherBadge, TeacherNotice, useTeacherContext } from "@/routes/LearnPage";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { dirOf, LOCALE_NAMES, LOCALES, type Locale } from "@/lib/types";
import {
  boundQuery,
  browseSearch,
  buildNoteLinks,
  isLocale,
  libraryApi,
  LIST_PAGE_SIZE,
  MAX_QUERY,
  publisherHost,
  publisherUrl,
  readBrowse,
  runKey,
  TOPICS,
  useGuardedResource,
  wordMeanings,
  type ApiCollection,
  type BrowseState,
  type NoteLinks,
  type Paragraph,
  type Topic,
  type WordMeaning,
} from "@/lib/library";
import { cn } from "@/lib/utils";
import {
  ArabicBlock,
  BackLink,
  Credit,
  ErrorBox,
  isolate,
  LoadingLine,
  LocaleBlock,
  Notice,
  NotesList,
  ReadingLanguage,
  Runs,
  SourceLink,
  StatusNote,
  TechDetails,
  TopicLabel,
  useReaderAnchor,
  useReadingLocale,
} from "./common";

export type Kind = "questions" | "hadith";
const API: Record<Kind, ApiCollection> = { questions: "fatwas", hadith: "hadith" };

function useBrowse(): [BrowseState, (next: Partial<BrowseState>) => void] {
  const [params, setParams] = useSearchParams();
  const browse = readBrowse(params);
  const set = (next: Partial<BrowseState>) => setParams(new URLSearchParams(browseSearch({ ...browse, ...next })));
  return [browse, set];
}

type PrepareState = { status: "none" | "error" } | { status: "ready"; sourceId: string };

function usePrepareSource(recordId: string | undefined): { status: "loading" } | PrepareState {
  const [state, setState] = useState<{ key: string; value: PrepareState } | null>(null);
  useEffect(() => {
    if (!recordId) return;
    let live = true;
    api.sources().then(
      (list) => {
        if (!live) return;
        const hit = Array.isArray(list)
          ? list.find((s) => (s as unknown as { library_record_id?: unknown }).library_record_id === recordId)
          : undefined;
        setState({ key: recordId, value: hit && typeof hit.id === "string" ? { status: "ready", sourceId: hit.id } : { status: "none" } });
      },
      () => {
        if (live) setState({ key: recordId, value: { status: "error" } });
      },
    );
    return () => {
      live = false;
    };
  }, [recordId]);
  if (!recordId || !state || state.key !== recordId) return { status: "loading" };
  return state.value;
}

function PrepareControl({ recordId }: { recordId: string }) {
  const { t } = useTranslation();
  const prep = usePrepareSource(recordId);
  if (prep.status === "loading") return null;
  if (prep.status === "ready")
    return (
      <div className="surface flex flex-wrap items-center gap-3 p-4" data-testid="prepare-control">
        <p className="min-w-0 flex-1 text-sm">{t("learn.prepare.body")}</p>
        <Button asChild variant="accent">
          <Link to={`/setup?source=${encodeURIComponent(prep.sourceId)}`} data-testid="prepare-lesson" data-source={prep.sourceId}>
            {t("learn.prepare.cta")}
          </Link>
        </Button>
      </div>
    );
  return (
    <p className="text-sm text-muted-foreground" data-testid="prepare-unavailable">
      {t("learn.prepare.none")}
    </p>
  );
}

export function CollectionList({ kind }: { kind: Kind }) {
  const { t } = useTranslation();
  const teacher = useTeacherContext(kind === "questions" ? "fatwa" : "hadith");
  const [browse, setBrowse] = useBrowse();
  const [locale, setLocale] = useReadingLocale();
  const { topic, q, page } = browse;
  const [input, setInput] = useState(q);
  useEffect(() => setInput(q), [q]);
  const key = `${kind}|${topic ?? ""}|${q}|${page}|${locale}`;
  const { state, retry } = useGuardedResource(key, (signal) =>
    libraryApi.list(API[kind], { topic, q, page, locale, pageSize: LIST_PAGE_SIZE }, signal),
  );
  const data = state?.status === "ready" ? state.data : null;
  const pages = data ? Math.max(1, Math.ceil(data.total / Math.max(1, data.page_size))) : 1;
  const here = { ...browse, lang: locale };
  const pageTo = (p: number) => `/library/${kind}${browseSearch({ ...here, page: p })}`;
  const chip = (value: Topic | null, label: string) => (
    <li key={value ?? "all"}>
      <button
        type="button"
        aria-pressed={topic === value}
        onClick={() => setBrowse({ topic: value, page: 1 })}
        className={cn(
          "inline-flex min-h-11 items-center rounded-full border px-4 font-medium",
          topic === value ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card hover:bg-muted",
        )}
      >
        {label}
      </button>
    </li>
  );

  return (
    <section className="bl-collection-page mx-auto max-w-4xl space-y-5" data-testid={`${kind}-list`}>
      <BackLink to="/library">{t("library.backHome")}</BackLink>
      <div>
        <h1 className="text-3xl font-bold">{t(`library.${kind}.title`)}</h1>
        <p className="mt-2 text-muted-foreground">{t(`library.${kind}.body`)}</p>
      </div>
      <div className="bl-filters bl-filters--stack">
      <form
        role="search"
        className="space-y-1"
        onSubmit={(e) => {
          e.preventDefault();
          setBrowse({ q: boundQuery(input), page: 1 });
        }}
      >
        <label htmlFor={`${kind}-search`} className="block font-semibold">
          {t("library.searchLabel")}
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id={`${kind}-search`}
            type="search"
            maxLength={MAX_QUERY}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="min-h-11 min-w-0 flex-1 rounded-md border border-input bg-card px-3 text-base"
            aria-describedby={`${kind}-search-hint`}
            data-testid="library-search"
          />
          <Button type="submit" className="min-h-11">
            {t("library.searchButton")}
          </Button>
          {q && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => {
                setInput("");
                setBrowse({ q: "", page: 1 });
              }}
            >
              {t("library.clearSearch")}
            </Button>
          )}
        </div>
        <p id={`${kind}-search-hint`} className="text-sm text-muted-foreground">
          {t("library.searchHint")}
        </p>
      </form>
      <ReadingLanguage value={locale} onChange={setLocale} />
      <div>
        <p className="mb-2 font-semibold" id={`${kind}-topics`}>
          {t("library.topicLabel")}
        </p>
        <ul className="flex flex-wrap gap-2" aria-labelledby={`${kind}-topics`}>
          {chip(null, t("library.allTopics"))}
          {TOPICS.map((tp) => chip(tp, t(`library.topics.${tp}`)))}
        </ul>
      </div>
      </div>
      {state?.status === "loading" && <LoadingLine>{t(`library.${kind}.loading`)}</LoadingLine>}
      {state?.status === "error" && <ErrorBox message={t(`library.${kind}.error`)} onRetry={retry} />}
      {data && (
        <>
          <p className="font-semibold" data-testid="result-count">
            {t("library.resultCount", { count: data.total })}
          </p>
          {data.items.length === 0 ? (
            <div className="space-y-3">
              <Notice testId="library-empty">
                {q ? t("library.emptySearch", { q: isolate(q) }) : t("library.emptyTopic")}
              </Notice>
              {(q || topic) && (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  data-testid="library-empty-reset"
                  onClick={() => {
                    setInput("");
                    setBrowse({ q: "", topic: null, page: 1 });
                  }}
                >
                  {t("library2.list.resetSearch")}
                </Button>
              )}
            </div>
          ) : (
            <ul className="bl-results" data-testid="item-list">
              {data.items.map((item) => (
                <li key={item.id}>
                  <Link
                    to={`/library/${kind}/${encodeURIComponent(item.id)}${browseSearch(here)}`}
                    state={{ title: item.translated_title ?? item.title }}
                    className="bl-result min-h-11 text-foreground no-underline"
                    data-testid="item-link"
                    data-id={item.id}
                  >
                    {item.translated_title ? (
                      <>
                        <span lang={locale} dir={dirOf(locale)} className="block text-lg font-semibold text-start">
                          {item.translated_title}
                        </span>
                        <span lang="ar" dir="rtl" className="bl-result__excerpt quote-ar block text-start">
                          {item.title}
                        </span>
                      </>
                    ) : (
                      <span lang="ar" dir="rtl" className="bl-result__title quote-ar block text-start">
                        {item.title}
                      </span>
                    )}
                    <span className="bl-result__meta mt-1 flex flex-wrap items-center justify-start gap-x-2 gap-y-1">
                      {teacher.get(item.id) && <TeacherBadge entry={teacher.get(item.id)!} />}
                      <TopicLabel topic={item.topic} />
                      {item.reference && (
                        <>
                          {" · "}
                          <bdi>{item.reference}</bdi>
                        </>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {pages > 1 && (
            <nav aria-label={t("library.pagination")} className="flex flex-wrap items-center justify-between gap-3">
              {page > 1 ? (
                <Link to={pageTo(page - 1)} className="inline-flex min-h-11 items-center rounded-md border border-input bg-card px-4 no-underline hover:bg-muted">
                  {t("library.prevPage")}
                </Link>
              ) : (
                <span />
              )}
              <span className="text-sm">{t("library.pageOf", { page, pages })}</span>
              {page < pages ? (
                <Link to={pageTo(page + 1)} className="inline-flex min-h-11 items-center rounded-md border border-input bg-card px-4 no-underline hover:bg-muted">
                  {t("library.nextPage")}
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}
    </section>
  );
}

function AvailableIn({ locales }: { locales?: string[] }) {
  const { t } = useTranslation();
  const names = (locales ?? []).filter(isLocale).map((l) => LOCALE_NAMES[l]);
  if (names.length === 0) return null;
  return (
    <p className="text-sm" data-testid="available-locales">
      {t("library.availableIn", { languages: names.join(" · ") })}
    </p>
  );
}

function useItemContext(kind: Kind) {
  const { id = "" } = useParams();
  const location = useLocation();
  const [params] = useSearchParams();
  const [locale, setLocale] = useReadingLocale();
  const browse = readBrowse(params);
  const hint = (location.state as { title?: unknown } | null)?.title;
  const label = typeof hint === "string" && hint ? hint : id;
  const back = `/library/${kind}${browseSearch({ ...browse, lang: locale })}`;
  return { id, locale, setLocale, label, back };
}

function usePlaceRestore(
  collection: ReadingCollection,
  id: string,
  record: { id: string; content_sha256?: string | null } | undefined,
  source: CurrentSource | null,
  resolve: (anchor: string) => string = (a) => a,
) {
  const location = useLocation();
  const { record: saved } = useReadingState();
  const snap = useRef<{ id: string; anchor: string | null; saved: ReadingRecord | null } | null>(null);
  if (!snap.current || snap.current.id !== id) snap.current = { id, anchor: anchorFromHash(location.hash), saved };
  const ready = !!record && record.id === id && !!source;
  const decision =
    ready && source ? restoreDecision(snap.current.anchor, snap.current.saved, { collection, id }, source) : { kind: "none" as const };
  const status = useRestoreAnchor({
    ready: ready && decision.kind === "restore",
    recordKey: `${collection}|${id}|${record?.content_sha256 ?? ""}`,
    anchor: decision.kind === "restore" ? resolve(decision.anchor) : null,
  });
  return decision.kind === "stale" ? "stale" : decision.kind === "missing" || status === "missing" ? "missing" : null;
}

function RestoreFallback({ reason }: { reason: "stale" | "missing" | null }) {
  const { t } = useTranslation();
  if (!reason) return null;
  return (
    <p role="status" className="surface px-3 py-2 text-sm" data-testid="restore-fallback" data-reason={reason}>
      {t(`learn.readingPlace.${reason}`)}
    </p>
  );
}

/** Note links of one paragraph, re-keyed for a `Runs` call that renders that paragraph alone. */
function paragraphLinks(links: NoteLinks | null | undefined, group: number, para: number, count: number): NoteLinks | null {
  if (!links) return null;
  const refs: NoteLinks["refs"] = {};
  for (let j = 0; j < count; j += 1) {
    const hit = links.refs[runKey(group, para, j)];
    if (hit) refs[runKey(0, 0, j)] = hit;
  }
  return { ...links, refs };
}

function MtParagraphs({
  paragraphs,
  locale,
  honorifics,
  className,
  links,
  group = 0,
}: {
  paragraphs: Paragraph[];
  locale: string;
  honorifics?: boolean;
  className?: string;
  links?: NoteLinks | null;
  group?: number;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn("space-y-3", className)} data-testid="mt-paragraphs">
      {paragraphs.map((para, i) => {
        const runs = Array.isArray(para) ? para : [];
        const pubs = runs.filter((run) => run.kind === "quran" && run.published && typeof run.published.text === "string");
        return (
          <div key={i}>
            <Runs paragraphs={[runs]} honorifics={honorifics} links={paragraphLinks(links, group, i, runs.length)} />
            {pubs.map((run, j) => (
              <p key={j} className="mt-1 border-s-2 border-border ps-3 text-sm" data-testid="mt-published">
                <span lang={locale} dir={dirOf(locale)}>
                  {run.published!.text}
                </span>{" "}
                <span className="text-muted-foreground">
                  (<bdi>{`${run.published!.surah}:${run.published!.ayah}`}</bdi> · {t("readers2.publishedMeaning", { lng: locale })} —{" "}
                  <bdi>{run.published!.edition}</bdi>)
                </span>
              </p>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Other reading languages that do have an AI-assisted translation of this fatwa. */
function MachineLocales({ locales, current, onPick }: { locales?: string[]; current: Locale; onPick: (l: Locale) => void }) {
  const { t } = useTranslation();
  const list = (Array.isArray(locales) ? locales : [])
    .filter(isLocale)
    .filter((l, i, all) => l !== current && l !== "ar" && all.indexOf(l) === i);
  if (list.length === 0) return null;
  return (
    <div className="space-y-2 text-sm" data-testid="mt-available-locales" data-locales={list.join(" ")}>
      <p>{t("readers2.aiAvailableIn")}</p>
      <ul className="flex flex-wrap gap-2">
        {list.map((l) => (
          <li key={l}>
            <Button type="button" variant="outline" className="min-h-11" lang={l} data-testid="mt-locale" data-locale={l} onClick={() => onPick(l)}>
              {LOCALE_NAMES[l]}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The shared reading-language control; in the translated view its hint says where the Arabic original is. */
function FatwaReadingLanguage({ value, onChange, originalLabel }: { value: Locale; onChange: (l: Locale) => void; originalLabel: string | null }) {
  const { t } = useTranslation();
  if (originalLabel === null) return <ReadingLanguage value={value} onChange={onChange} />;
  return (
    <div className="space-y-1">
      <label className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{t("library.readingLanguage")}</span>
        <select
          className="min-h-11 rounded-md border border-input bg-card px-3 text-base"
          value={value}
          onChange={(e) => {
            if (isLocale(e.target.value)) onChange(e.target.value);
          }}
          data-testid="reading-language"
        >
          {LOCALES.map((l) => (
            <option key={l} value={l} lang={l}>
              {LOCALE_NAMES[l]}
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm text-muted-foreground" data-testid="reading-language-hint">
        {t("readers2.readingHintTranslated", { label: originalLabel })}
      </p>
    </div>
  );
}

export function FatwaReader() {
  const { t, i18n } = useTranslation();
  const assistant = useAssistant();
  const location = useLocation();
  const [originalOpen, setOriginalOpen] = useState<{ key: string; open: boolean } | null>(null);
  const { id, locale, setLocale, label, back } = useItemContext("questions");
  const { state, retry } = useGuardedResource(`fatwa|${id}|${locale}`, (signal) => libraryApi.fatwa(id, locale, signal));
  const data = state?.status === "ready" ? state.data : null;
  const r = data?.record;
  const tr = data?.translation_status === "available" ? data.translation : null;
  const translated = tr && Array.isArray(tr.answer) && tr.answer.length > 0 ? tr : null;
  const mtRaw = data?.machine_translation;
  const mt =
    !translated && locale !== "ar" && mtRaw && mtRaw.locale === locale && Array.isArray(mtRaw.answer) && mtRaw.answer.length > 0
      ? mtRaw
      : null;
  const sourceHref = r ? publisherUrl(r.source.url) : null;
  const honorifics = sourceHref !== null && publisherHost(sourceHref) === "binbaz.org.sa";
  const links = r ? buildNoteLinks(r.id, [r.question, r.answer], r.notes) : null;
  const teacher = useTeacherContext("fatwa").get(r?.id ?? id);
  const source = r && typeof r.content_sha256 === "string" ? fatwaSource(r) : null;
  const place = (anchor: string): ReadingLocation | null =>
    r && typeof r.content_sha256 === "string"
      ? {
          collection: "fatwa",
          id: r.id,
          version: fatwaVersion(r),
          sha256: r.content_sha256,
          anchor,
          title: r.title,
          href: `/library/questions/${encodeURIComponent(r.id)}?lang=${locale}`,
        }
      : null;
  const mtNotes = (mt && Array.isArray(mt.notes) ? mt.notes : []).filter(
    (n, i, all) => n && typeof n.id === "string" && all.findIndex((m) => m?.id === n.id) === i,
  );
  const mtLinks =
    mt && r
      ? buildNoteLinks(
          `mt-${r.id}`,
          [Array.isArray(mt.question) ? mt.question : [], mt.answer],
          mtNotes.map((n) => ({ id: n.id, runs: [] })),
        )
      : null;
  /** A saved place names a section of the source; in the translated view it resolves to the visible translated element. */
  const visibleAnchor = (a: string): string => {
    if (!mt || !r) return a;
    if (a === "fatwa-question") return "fatwa-mt-question";
    if (a === "fatwa-answer") return "fatwa-mt-answer";
    const prefix = `note-${r.id}-`;
    const noteId = a.startsWith(prefix) ? a.slice(prefix.length) : null;
    return noteId !== null && mtNotes.some((n) => n.id === noteId) ? (mtLinks?.targets[noteId] ?? a) : a;
  };
  const viewKey = `${id}|${locale}`;
  const hashAnchor = anchorFromHash(location.hash);
  const originalWanted = !!mt && !!hashAnchor && !!source?.hasAnchor(hashAnchor) && visibleAnchor(hashAnchor) === hashAnchor;
  const fallback = usePlaceRestore("fatwa", id, r, source, visibleAnchor);
  useEffect(() => {
    const loc = place("fatwa-question");
    if (loc) recordOpened(loc);
  }, [r?.id, r?.content_sha256, locale]);
  useAssistantScope(
    r && r.id === id && typeof r.content_sha256 === "string" && typeof r.schema === "string"
      ? {
          mode: "fatwa",
          title: translated?.title || r.title,
          locale,
          href: `/library/questions/${encodeURIComponent(r.id)}?lang=${locale}`,
          context: { record_id: r.id, sha256: r.content_sha256, version: r.schema },
        }
      : null,
  );
  const tracked = mt ? ["fatwa-mt-question", "fatwa-mt-answer"] : ["fatwa-question", "fatwa-answer"];
  const anchor = useReaderAnchor(r && typeof r.content_sha256 === "string" ? tracked : []);
  const savePlace = anchor ? place(anchor.replace(/^fatwa-mt-/, "fatwa-")) : null;

  return (
    <article className="bl-reader space-y-5" data-testid="fatwa-reader" data-id={r?.id ?? ""} data-view={mt ? "machine" : translated ? "published" : "original"}>
      <div className="bl-readerbar">
        <BackLink to={back}>{t("library.questions.back")}</BackLink>
        <div className="bl-readerbar__tools">
          <FatwaReadingLanguage value={locale} onChange={setLocale} originalLabel={mt ? t("readers2.showArabic", { lng: locale }) : null} />
        </div>
      </div>
      {savePlace && (
        <div className="bl-reader__save" data-testid="reader-save">
          <SavePlaceButton loc={savePlace} />
        </div>
      )}
      <ReadingStoreNotice />
      <RestoreFallback reason={fallback} />
      {state?.status === "loading" && (
        <LoadingLine>{t("library.questions.itemLoading", { title: isolate(label) })}</LoadingLine>
      )}
      {state?.status === "error" && (
        <ErrorBox
          message={
            state.error.status === 404
              ? t("library.questions.notFound", { title: isolate(label) })
              : t("library.questions.itemError", { title: isolate(label) })
          }
          onRetry={retry}
        />
      )}
      {r && data && (
        <div className="bl-reader__grid">
          <div className="bl-reader__main">
          <header className="space-y-2">
            {mt ? (
              <>
                <h1 lang={locale} dir={dirOf(locale)} className="bl-read__title text-start" data-testid="item-title">
                  {mt.title || r.title}
                </h1>
                <p lang={locale} dir={dirOf(locale)} className="text-xs font-semibold text-muted-foreground" data-testid="mt-label">
                  {t("readers2.aiAssisted", { lng: locale })}
                </p>
                <p lang="ar" dir="rtl" className="quote-ar text-muted-foreground" data-testid="item-title-ar">
                  {r.title}
                </p>
              </>
            ) : (
              <h1 lang="ar" dir="rtl" className="bl-read__title quote-ar text-start" data-testid="item-title">
                {r.title}
              </h1>
            )}
            <p className="text-sm text-muted-foreground">
              <TopicLabel topic={r.topic} />
              {r.source.publisher_name && (
                <>
                  {" · "}
                  <bdi>{r.source.publisher_name}</bdi>
                </>
              )}
            </p>
          </header>
          {teacher && <TeacherNotice entry={teacher} />}
          {locale !== "ar" && !translated && !mt && (
            <Notice testId="translation-unavailable">
              {t("library.questions.unavailable", { language: LOCALE_NAMES[locale] })}
            </Notice>
          )}
          {locale !== "ar" && !translated && !mt && <AvailableIn locales={data.available_locales} />}
          {locale !== "ar" && !translated && !mt && <MachineLocales locales={data.machine_locales} current={locale} onPick={setLocale} />}
          {locale !== "ar" && !translated && !mt && (
            <div lang={locale} dir={dirOf(locale)} className="bl-help-understand" data-testid="fatwa-language-help">
              {i18n.language !== locale && <p>{t("readers2.fatwaNote", { lng: locale })}</p>}
              {assistant && (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  data-testid="fatwa-help-understand"
                  onClick={() => assistant.openWith({ scope: "source", question: t("readers2.helpQuestion", { lng: locale }) })}
                >
                  {t("readers2.helpUnderstand", { lng: locale })}
                </Button>
              )}
            </div>
          )}
          {translated && (
            <section className="bl-sheet bl-read bl-read--translation" data-testid="fatwa-translation">
              <h2 className="bl-read__kicker">{LOCALE_NAMES[locale]}</h2>
              <LocaleBlock locale={locale} className="text-lg">
                {translated.question && <Runs paragraphs={translated.question} honorifics={honorifics} />}
                <Runs paragraphs={translated.answer!} className="mt-4" honorifics={honorifics} />
              </LocaleBlock>
            </section>
          )}
          {mt && (
            <section className="bl-sheet bl-read bl-read--translation" data-testid="fatwa-mt">
              <LocaleBlock locale={locale} className="text-lg">
                <div id="fatwa-mt-question" className="scroll-mt-24" data-testid="fatwa-mt-question">
                  <MtParagraphs paragraphs={Array.isArray(mt.question) ? mt.question : []} locale={locale} honorifics={honorifics} links={mtLinks} group={0} />
                </div>
                <div id="fatwa-mt-answer" className="mt-4 scroll-mt-24" data-testid="fatwa-mt-answer">
                  <MtParagraphs paragraphs={mt.answer} locale={locale} honorifics={honorifics} links={mtLinks} group={1} />
                </div>
                {mtNotes.length > 0 && (
                  <ol
                    className="mt-6 list-none space-y-3 border-t border-border ps-0 pt-4 text-base"
                    aria-label={t("readers2.notesTitle", { lng: locale })}
                    data-testid="mt-notes"
                  >
                    {mtNotes.map((n) => {
                      const noteBack = mtLinks?.backs[n.id];
                      const noteTarget = mtLinks?.targets[n.id];
                      return (
                        <li key={n.id} id={typeof noteTarget === "string" ? noteTarget : undefined} className="scroll-mt-24 rounded-md target:bg-muted" data-testid="mt-note" data-note={n.id}>
                          <span className="me-2 font-semibold" data-testid="mt-note-number">
                            [<bdi>{n.id}</bdi>]
                          </span>
                          <MtParagraphs paragraphs={Array.isArray(n.paragraphs) ? n.paragraphs : []} locale={locale} honorifics={honorifics} />
                          {typeof noteBack === "string" && (
                            <a
                              href={`#${noteBack}`}
                              className="inline-flex min-h-11 items-center text-sm font-semibold text-primary underline underline-offset-4"
                              data-testid="mt-note-back"
                            >
                              {t("library.notes.back", { id: n.id, lng: locale })}
                            </a>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </LocaleBlock>
            </section>
          )}
          {(() => {
            const original = (
              <section className="bl-sheet bl-read" aria-labelledby="fatwa-original">
                <h2 id="fatwa-original" className="bl-read__kicker">
                  {t("library.arabicOriginal")}
                </h2>
                <ArabicBlock className="text-xl leading-loose" testId="item-original">
                  <div id="fatwa-question" data-testid="fatwa-question">
                    <Runs paragraphs={r.question} honorifics={honorifics} links={links} group={0} />
                  </div>
                  <hr className="my-4 border-border" />
                  <div id="fatwa-answer" data-testid="fatwa-answer">
                    <Runs paragraphs={r.answer} honorifics={honorifics} links={links} group={1} />
                  </div>
                </ArabicBlock>
                {links && <NotesList recordId={r.id} notes={r.notes} links={links} honorifics={honorifics} />}
              </section>
            );
            return mt ? (
              <details
                className="bl-mt-original"
                data-testid="fatwa-original-disclosure"
                open={originalOpen?.key === viewKey ? originalOpen.open : originalWanted}
                onToggle={(e) => setOriginalOpen({ key: viewKey, open: e.currentTarget.open })}
              >
                <summary className="min-h-11 cursor-pointer py-2 font-semibold" lang={locale} dir={dirOf(locale)}>
                  {t("readers2.showArabic", { lng: locale })}
                </summary>
                {original}
              </details>
            ) : (
              original
            );
          })()}
          <section className="bl-source" aria-labelledby="fatwa-source" data-testid="reader-source">
            <h2 id="fatwa-source" className="bl-source__title">
              {t("setup.source")}
            </h2>
            {r.source.publisher_name && (
              <p className="bl-source__pub" lang="ar" dir="rtl">
                {r.source.publisher_name}
              </p>
            )}
            <Credit label={t("library.questions.publisher")} url={r.source.url} retrievedAt={r.source.retrieved_at} />
            {translated && <SourceLink url={translated.source_url} />}
            {r.source_categories.length > 0 && (
              <p className="bl-attrib-card__series">
                <span className="font-semibold">{t("library.sourceCategories")}: </span>
                {r.source_categories.map((c, i) => (
                  <span key={c.id}>
                    {i > 0 && "، "}
                    <bdi lang="ar">{c.label}</bdi>
                  </span>
                ))}
              </p>
            )}
            <StatusNote />
            <TechDetails
              rows={[
                ["id", r.id],
                ["schema", r.schema],
                ["retrievedAt", r.source.retrieved_at],
                ["contentHash", r.content_sha256],
                ["rawHash", r.raw_sha256],
                ["reuse", r.reuse_basis],
                ["review", r.review_status],
              ]}
            />
          </section>
          </div>
          <aside className="bl-reader__side">
          <PrepareControl recordId={r.id} />
          </aside>
        </div>
      )}
    </article>
  );
}

const LANG_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

function WordList({ words }: { words: WordMeaning[] }) {
  return (
    <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr]">
      {words.map((w, i) => (
        <div key={i} className="contents" data-testid="word-meaning">
          <dt className="font-semibold">{w.word}</dt>
          <dd className="whitespace-pre-line">{w.meaning}</dd>
        </div>
      ))}
    </dl>
  );
}

export function HadithReader() {
  const { t } = useTranslation();
  const { id, locale, setLocale, label, back } = useItemContext("hadith");
  const { state, retry } = useGuardedResource(`hadith|${id}|${locale}`, (signal) =>
    libraryApi.hadith(id, locale, signal),
  );
  const data = state?.status === "ready" ? state.data : null;
  const r = data?.record;
  const tr = data?.translation_status === "available" && locale !== "ar" ? data.translation : null;
  const explanation = tr?.explanation ? { text: tr.explanation, hints: tr.hints ?? [], loc: locale } : null;
  const arabicWords = wordMeanings(r?.words_meanings);
  const localWords = tr && typeof tr.words_meanings_language === "string" && LANG_TAG.test(tr.words_meanings_language)
    ? { lang: tr.words_meanings_language, words: wordMeanings(tr.words_meanings) }
    : null;
  const arabicMatch = tr?.arabic_match === "exact" || tr?.arabic_match === "not_provided" ? tr.arabic_match : null;
  const teacher = useTeacherContext("hadith").get(r?.id ?? id);
  const source = r && typeof r.content_sha256 === "string" ? hadithSource(r) : null;
  const place = (anchor: string): ReadingLocation | null =>
    r && typeof r.content_sha256 === "string" && source?.hasAnchor(anchor)
      ? {
          collection: "hadith",
          id: r.id,
          version: hadithVersion(r),
          sha256: r.content_sha256,
          anchor,
          title: r.title,
          href: `/library/hadith/${encodeURIComponent(r.id)}?lang=${locale}`,
        }
      : null;
  const fallback = usePlaceRestore("hadith", id, r, source);
  useEffect(() => {
    const loc = place("hadith-text");
    if (loc) recordOpened(loc);
  }, [r?.id, r?.content_sha256, locale]);
  useAssistantScope(
    r && r.id === id && typeof r.content_sha256 === "string" && typeof r.schema === "string"
      ? {
          mode: "hadith",
          title: tr?.title || r.title,
          locale,
          href: `/library/hadith/${encodeURIComponent(r.id)}?lang=${locale}`,
          context: { record_id: r.id, sha256: r.content_sha256, version: r.schema },
        }
      : null,
  );
  const anchor = useReaderAnchor(["hadith-text", "hadith-explanation"].filter((a) => place(a) !== null));
  const savePlace = anchor ? place(anchor) : null;
  const techExtra: [string, string, string?][] = arabicMatch
    ? [[t("library.arabicMatch.label"), t(`library.arabicMatch.${arabicMatch}`)]]
    : [];
  if (r) {
    techExtra.push([
      t("library.hadith.dorar"),
      !r.dorar || r.dorar.status === "not_verified"
        ? t("library.hadith.dorarNotChecked")
        : t("library.hadith.dorarStatus", { status: r.dorar.status }),
      "hadith-dorar",
    ]);
  }

  return (
    <article className="bl-reader space-y-5" data-testid="hadith-reader" data-id={r?.id ?? ""}>
      <div className="bl-readerbar">
        <BackLink to={back}>{t("library.hadith.back")}</BackLink>
        <div className="bl-readerbar__tools">
          <ReadingLanguage value={locale} onChange={setLocale} />
        </div>
      </div>
      {savePlace && (
        <div className="bl-reader__save" data-testid="reader-save">
          <SavePlaceButton loc={savePlace} />
        </div>
      )}
      <ReadingStoreNotice />
      <RestoreFallback reason={fallback} />
      {state?.status === "loading" && (
        <LoadingLine>{t("library.hadith.itemLoading", { title: isolate(label) })}</LoadingLine>
      )}
      {state?.status === "error" && (
        <ErrorBox
          message={
            state.error.status === 404
              ? t("library.hadith.notFound", { title: isolate(label) })
              : t("library.hadith.itemError", { title: isolate(label) })
          }
          onRetry={retry}
        />
      )}
      {r && data && (
        <div className="bl-reader__grid">
          <div className="bl-reader__main">
          <header className="space-y-2">
            {tr?.title ? (
              <h1 lang={locale} dir={dirOf(locale)} className="bl-read__title bl-read__title--sm text-start" data-testid="item-title">
                {tr.title}
              </h1>
            ) : (
              <h1 lang="ar" dir="rtl" className="bl-read__title quote-ar text-start" data-testid="item-title">
                {r.title}
              </h1>
            )}
            <p className="text-sm text-muted-foreground">
              <TopicLabel topic={r.topic} />
              {" · "}
              <bdi>{r.source.publisher}</bdi>
            </p>
          </header>
          {teacher && <TeacherNotice entry={teacher} />}
          {locale !== "ar" && !tr && (
            <Notice testId="translation-unavailable">
              {t("library.hadith.unavailable", { language: LOCALE_NAMES[locale] })}
            </Notice>
          )}
          {locale !== "ar" && !tr && <AvailableIn locales={data.available_locales} />}
          <section className="bl-sheet bl-read" aria-labelledby="hadith-original">
            <h2 id="hadith-original" className="bl-read__kicker">
              {t("library.arabicOriginal")}
            </h2>
            <ArabicBlock className="space-y-3" testId="item-original">
              {tr?.title && <p className="text-xl font-semibold">{r.title}</p>}
              <p id="hadith-text" className="whitespace-pre-line text-xl leading-loose" data-testid="hadith-text">
                {r.text}
              </p>
            </ArabicBlock>
            <dl className="mt-4 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
              {r.attribution && (
                <>
                  <dt className="font-semibold">{t("library.hadith.attribution")}</dt>
                  <dd lang="ar" dir="rtl" className="quote-ar text-start">
                    {r.attribution}
                  </dd>
                </>
              )}
              {r.narrator && (
                <>
                  <dt className="font-semibold">{t("library.hadith.narrator")}</dt>
                  <dd lang="ar" dir="rtl" className="quote-ar text-start">
                    {r.narrator}
                  </dd>
                </>
              )}
              {r.grade && (
                <>
                  <dt className="font-semibold">{t("library.hadith.grade")}</dt>
                  <dd className="flex flex-wrap items-baseline gap-x-2" data-testid="hadith-grade-line">
                    <span lang="ar" dir="rtl" className="quote-ar" data-testid="hadith-grade">
                      {r.grade}
                    </span>
                    {r.grading_authority && (
                      <span className="text-muted-foreground">
                        {t("library.hadith.gradedBy")}: <bdi>{r.grading_authority}</bdi>
                      </span>
                    )}
                  </dd>
                </>
              )}
              {!r.grade && r.grading_authority && (
                <>
                  <dt className="font-semibold">{t("library.hadith.gradedBy")}</dt>
                  <dd>
                    <bdi>{r.grading_authority}</bdi>
                  </dd>
                </>
              )}
            </dl>
          </section>
          {arabicWords.length > 0 && (
            <section className="surface p-4" aria-labelledby="hadith-words" data-testid="hadith-words">
              <h2 id="hadith-words" className="text-lg font-semibold">
                {t("library.words.arabicTitle")}
              </h2>
              <p className="mb-3 text-sm text-muted-foreground">{t("library.words.arabicHint")}</p>
              <ArabicBlock className="text-lg" testId="hadith-words-list">
                <WordList words={arabicWords} />
              </ArabicBlock>
            </section>
          )}
          {tr && (
            <section className="bl-sheet bl-read bl-read--translation" aria-labelledby="hadith-translation">
              <h2 id="hadith-translation" className="bl-read__kicker">
                {t("library.hadith.translationLabel", { language: LOCALE_NAMES[locale] })}
              </h2>
              <LocaleBlock locale={locale} className="space-y-3" testId="hadith-translation">
                {tr.text && <p className="whitespace-pre-line text-lg">{tr.text}</p>}
                {(tr.attribution || tr.grade) && (
                  <p className="text-sm">
                    {[tr.attribution, tr.grade].filter(Boolean).join(" — ")}
                  </p>
                )}
              </LocaleBlock>
            </section>
          )}
          {localWords && localWords.words.length > 0 && (
            <section
              className="surface p-4"
              aria-labelledby="hadith-words-local"
              data-testid="hadith-words-localized"
            >
              <h2 id="hadith-words-local" className="mb-3 text-lg font-semibold">
                {t("library.words.localizedTitle", {
                  language: isLocale(localWords.lang) ? LOCALE_NAMES[localWords.lang] : localWords.lang,
                })}
              </h2>
              <LocaleBlock locale={localWords.lang} className="text-lg" testId="hadith-words-localized-list">
                <WordList words={localWords.words} />
              </LocaleBlock>
            </section>
          )}
          {(explanation || r.explanation || r.hints.length > 0) && (
            <section id="hadith-explanation" className="rounded-lg border-2 border-dashed border-border bg-card p-4" aria-labelledby="hadith-explanation-title" data-testid="hadith-explanation">
              <h2 id="hadith-explanation-title" className="text-lg font-semibold">
                {t("library.hadith.explanation")}
              </h2>
              <p className="mb-3 text-sm text-muted-foreground">
                {explanation ? LOCALE_NAMES[locale] : t("library.arabicOriginal")}
              </p>
              {explanation ? (
                <>
                  <LocaleBlock locale={explanation.loc}>
                    <p className="whitespace-pre-line">{explanation.text}</p>
                  </LocaleBlock>
                  {explanation.hints.length > 0 && (
                    <>
                      <h3 className="mt-4 font-semibold">{t("library.hadith.hints")}</h3>
                      <LocaleBlock locale={explanation.loc}>
                        <ul className="list-disc space-y-1 ps-5">
                          {explanation.hints.map((h, i) => (
                            <li key={i} className="whitespace-pre-line">{h}</li>
                          ))}
                        </ul>
                      </LocaleBlock>
                    </>
                  )}
                </>
              ) : (
                <>
                  {r.explanation && (
                    <ArabicBlock className="text-lg">
                      <p className="whitespace-pre-line">{r.explanation}</p>
                    </ArabicBlock>
                  )}
                  {r.hints.length > 0 && (
                    <>
                      <h3 className="mt-4 font-semibold">{t("library.hadith.hints")}</h3>
                      <ArabicBlock className="text-lg">
                        <ul className="list-disc space-y-1 ps-5">
                          {r.hints.map((h, i) => (
                            <li key={i} className="whitespace-pre-line">{h}</li>
                          ))}
                        </ul>
                      </ArabicBlock>
                    </>
                  )}
                </>
              )}
            </section>
          )}
          <section className="bl-source" aria-labelledby="hadith-source" data-testid="reader-source">
            <h2 id="hadith-source" className="bl-source__title">
              {t("setup.source")}
            </h2>
            <p className="bl-source__pub">
              <bdi>{r.source.publisher}</bdi>
            </p>
            <Credit
              label={r.source.publisher}
              url={r.source.url}
              linkText={t("library.hadith.openArabic")}
              retrievedAt={r.source.retrieved_at}
            />
            {tr && (
              <Credit
                label={r.source.publisher}
                url={tr.source_url}
                linkText={t("library.hadith.openTranslation")}
                retrievedAt={tr.retrieved_at}
              />
            )}
            <StatusNote />
            {r.reference && (
              <details className="rounded-lg border border-border bg-card p-3 text-sm" data-testid="hadith-reference-details">
                <summary className="min-h-10 cursor-pointer py-2 font-semibold">{t("library.hadith.reference")}</summary>
                <p lang="ar" dir="rtl" className="quote-ar mt-2 whitespace-pre-line text-start" data-testid="hadith-reference">
                  {r.reference}
                </p>
              </details>
            )}
            <TechDetails
              rows={[
                ["id", r.id],
                ["schema", r.schema],
                ["retrievedAt", r.source.retrieved_at],
                ["apiUrl", r.source.api_url],
                ["contentHash", r.content_sha256],
                ["reuse", r.reuse_basis],
                ["review", r.review_status],
                ["dorarReason", r.dorar?.reason],
                ["mapping", tr?.mapping],
                ["translationLanguage", tr?.source_language_code],
                ["translationRetrievedAt", tr?.retrieved_at],
                ["translationApiUrl", tr?.api_url],
                ["translationHash", tr?.content_sha256],
              ]}
              extra={techExtra}
            />
          </section>
          </div>
          <aside className="bl-reader__side">
          <PrepareControl recordId={r.id} />
          </aside>
        </div>
      )}
    </article>
  );
}
