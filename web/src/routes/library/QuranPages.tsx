import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import QuranPlayer, { type ActiveAyah, type QuranPlayerController } from "@/components/QuranPlayer";
import { ReadingStoreNotice, SavePlaceButton, useRestoreAnchor } from "@/components/ReadingPlace";
import { useAssistantScope } from "@/components/assistant/AssistantProvider";
import {
  anchorFromHash,
  recordReading,
  restoreDecision,
  surahSource,
  surahVersion,
  useReadingState,
  type ReadingLocation,
  type ReadingRecord,
  type RestoreDecision,
} from "@/lib/reading";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { LOCALE_NAMES } from "@/lib/types";
import { browseSearch, libraryApi, surahNumber, useGuardedResource, type QuranIndex, type Surah } from "@/lib/library";
import { RangeLabel } from "./LibraryHome";
import {
  ArabicBlock,
  BackLink,
  EditionCredits,
  ErrorBox,
  isolate,
  LoadingLine,
  LocaleBlock,
  Notice,
  ReadingLanguage,
  SourceLink,
  StatusNote,
  TafsirCredit,
  TechDetails,
  useReadingLocale,
} from "./common";

function useQuranIndex() {
  return useGuardedResource<QuranIndex>("quran-index", (signal) => libraryApi.quran(signal));
}

function placeOf(s: Surah, ayah: number, title: string, locale: string): ReadingLocation | null {
  if (typeof s.content_sha256 !== "string") return null;
  return {
    collection: "quran",
    id: String(s.number),
    version: surahVersion(s),
    sha256: s.content_sha256,
    anchor: `ayah-${ayah}`,
    title,
    href: `/library/quran/${s.number}?lang=${locale}`,
  };
}

function EditionBlock({ surah, index, locale }: { surah: Surah; index: QuranIndex | null; locale: string }) {
  const { t } = useTranslation();
  if (surah.translation_status !== "available" || !surah.edition) return null;
  const listed = index?.editions.find((e) => e.key === surah.edition?.key);
  return (
    <>
      <p className="flex flex-wrap items-center gap-x-3" data-testid="edition-line">
        <span className="font-semibold">
          {t("library.quran.editionLine", {
            language: LOCALE_NAMES[locale as keyof typeof LOCALE_NAMES],
            title: isolate(surah.edition.title),
            version: surah.edition.version ?? "—",
          })}
        </span>
      </p>
      <EditionCredits
        edition={{
          ...surah.edition,
          description: surah.edition.description ?? listed?.description,
          browse_url: surah.edition.browse_url ?? listed?.browse_url,
        }}
      />
    </>
  );
}

function NowText({
  focus,
  res,
  index,
  locale,
  tafsirOn,
  playing,
}: {
  focus: ActiveAyah;
  res: { state: ReturnType<typeof useGuardedResource<Surah>>["state"]; retry: () => void };
  index: QuranIndex | null;
  locale: string;
  tafsirOn: boolean;
  playing: boolean;
}) {
  const { t } = useTranslation();
  const name = index?.surahs.find((s) => s.number === focus.surah)?.name_ar ?? String(focus.surah);
  const data = res.state?.status === "ready" ? res.state.data : null;
  const row = data?.number === focus.surah ? data.ayahs.find((a) => a.aya === focus.ayah) : undefined;
  return (
    <section
      className="bl-sheet bl-qnow"
      aria-labelledby="quran-now-title"
      tabIndex={0}
      data-testid="quran-now"
      data-ref={`${focus.surah}:${focus.ayah}`}
      data-playing={playing ? "true" : "false"}
      data-locale={data?.locale ?? ""}
    >
      <h2 id="quran-now-title" className="bl-ayah__ref">
        {t("audio.nowTitle", { name, surah: focus.surah, ayah: focus.ayah })}
      </h2>
      {res.state?.status === "loading" && (
        <p role="status" className="text-muted-foreground" data-testid="quran-now-loading">
          {t("audio.nowLoading")}
        </p>
      )}
      {res.state?.status === "error" && (
        <div data-testid="quran-now-error">
          <ErrorBox message={t("audio.nowError")} onRetry={res.retry} />
        </div>
      )}
      {data && !row && <Notice testId="quran-now-missing">{t("audio.nowMissing")}</Notice>}
      {data && row && (
        <>
          <ArabicBlock className="bl-qnow__arabic" testId="quran-now-arabic">
            <p>{row.arabic}</p>
          </ArabicBlock>
          {data.translation_status === "available" && row.translation && (
            <LocaleBlock locale={data.locale} className="bl-qnow__meanings" testId="quran-now-translation">
              <p className="whitespace-pre-line">{row.translation}</p>
            </LocaleBlock>
          )}
          {data.translation_status === "available" && row.footnotes && (
            <div className="border-s-4 border-border ps-3 text-sm" data-testid="quran-now-footnote">
              <p className="font-semibold">{t("library.quran.footnote")}</p>
              <LocaleBlock locale={data.locale}>
                <p className="whitespace-pre-line">{row.footnotes}</p>
              </LocaleBlock>
            </div>
          )}
          {data.translation_status === "unavailable" && (
            <Notice>{t("library.quran.translationUnavailable", { language: LOCALE_NAMES[locale as keyof typeof LOCALE_NAMES] })}</Notice>
          )}
          <div className="space-y-1 text-sm" data-testid="quran-now-edition">
            <EditionBlock surah={data} index={index} locale={locale} />
          </div>
          {tafsirOn && row.tafsir && (
            <div className="rounded-md bg-muted p-3" data-testid="quran-now-tafsir">
              <p className="text-sm font-semibold">{t("library.quran.tafsirLabel")}</p>
              <ArabicBlock className="mt-1 text-lg">
                <p className="whitespace-pre-line">{row.tafsir}</p>
              </ArabicBlock>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function QuranList() {
  const { t } = useTranslation();
  const [locale, setLocale] = useReadingLocale();
  const { state, retry } = useQuranIndex();
  const index = state?.status === "ready" ? state.data : null;
  const edition = index?.editions.find((e) => e.locale === locale) ?? null;

  return (
    <section className="mx-auto max-w-3xl space-y-5" data-testid="quran-list">
      <BackLink to="/library">{t("library.backHome")}</BackLink>
      <h1 className="text-3xl font-bold">{t("library.quran.title")}</h1>
      {index && (
        <p className="text-lg font-semibold" data-testid="quran-range">
          <RangeLabel range={index.range} />
        </p>
      )}
      <ReadingLanguage value={locale} onChange={setLocale} />
      {index && (
        <p className="text-sm" data-testid="quran-edition">
          {locale === "ar"
            ? t("library.quran.originalOnly")
            : edition
              ? t("library.quran.editionLine", {
                  language: LOCALE_NAMES[locale],
                  title: isolate(edition.title),
                  version: edition.version ?? "—",
                })
              : t("library.quran.translationUnavailable", { language: LOCALE_NAMES[locale] })}
        </p>
      )}
      {edition && locale !== "ar" && (
        <div className="space-y-1 text-sm" data-testid="quran-edition-credits">
          <EditionCredits edition={edition} />
        </div>
      )}
      {edition && locale !== "ar" && <SourceLink url={edition.browse_url}>{t("library.quran.openEdition")}</SourceLink>}
      {state?.status === "loading" && <LoadingLine>{t("library.quran.loadingList")}</LoadingLine>}
      {state?.status === "error" && <ErrorBox message={t("library.quran.listError")} onRetry={retry} />}
      {index && (
        <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label={t("library.quran.surahList")}>
          {index.surahs.map((s) => (
            <li key={s.number}>
              <Link
                to={`/library/quran/${s.number}${browseSearch({ lang: locale })}`}
                className="flex min-h-12 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-foreground no-underline hover:border-primary"
                data-testid="surah-link"
              >
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">
                  {s.number}
                </span>
                <span className="flex-1">
                  <span lang="ar" dir="rtl" className="quote-ar block text-lg font-semibold">
                    {s.name_ar}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    {t("library.quran.ayahs", { count: s.ayah_count })}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function SurahReader() {
  const { t } = useTranslation();
  const params = useParams();
  const n = surahNumber(params.surah);
  const [locale, setLocale] = useReadingLocale();
  const [search, setSearch] = useSearchParams();
  const indexRes = useQuranIndex();
  const index = indexRes.state?.status === "ready" ? indexRes.state.data : null;
  const pos = index && n !== null ? index.surahs.findIndex((s) => s.number === n) : -1;
  const summary = index && pos >= 0 ? index.surahs[pos] : null;
  const tafsirEntry = index?.tafsir[0] ?? null;
  const tafsirKey = tafsirEntry?.key ?? null;
  const tafsirOn = search.get("tafsir") === "1" && tafsirKey !== null;
  const [active, setActive] = useState<ActiveAyah | null>(null);
  const player = useRef<QuranPlayerController>(null);
  const names = useMemo(() => Object.fromEntries((index?.surahs ?? []).map((s) => [s.number, s.name_ar])), [index]);
  const key = summary ? `quran|${summary.number}|${locale}|${tafsirOn ? tafsirKey : ""}` : null;
  const { state, retry } = useGuardedResource(key, (signal) =>
    libraryApi.surah(summary!.number, locale, tafsirOn ? tafsirKey : null, signal),
  );
  const listTo = `/library/quran${browseSearch({ lang: locale })}`;
  const name = summary?.name_ar ?? String(params.surah ?? "");
  const surah = state?.status === "ready" ? state.data : null;
  const [focus, setFocus] = useState<ActiveAyah | null>(null);
  const [pendingSave, setPendingSave] = useState<ActiveAyah | null>(null);
  const focusOther = focus !== null && summary !== null && focus.surah !== summary.number ? focus.surah : null;
  const other = useGuardedResource(
    focusOther === null ? null : `quran|${focusOther}|${locale}|${tafsirOn ? tafsirKey : ""}`,
    (signal) => libraryApi.surah(focusOther!, locale, tafsirOn ? tafsirKey : null, signal),
  );
  const focusRes = focusOther === null ? { state, retry } : other;
  const focusData = focusRes.state?.status === "ready" ? focusRes.state.data : null;
  useEffect(() => {
    if (!pendingSave || !focusData || focusData.number !== pendingSave.surah) return;
    const loc = placeOf(focusData, pendingSave.ayah, names[pendingSave.surah] ?? focusData.name_ar, locale);
    if (loc) recordReading(loc);
    setPendingSave(null);
  }, [pendingSave, focusData, names, locale]);
  const focusMatch = focus !== null && focusData !== null && focusData.number === focus.surah ? focusData : null;
  useAssistantScope(
    summary && surah && surah.number === summary.number
      ? {
          mode: "quran",
          title: summary.name_ar,
          locale,
          href: `/library/quran/${summary.number}?lang=${locale}`,
          edition: surah.translation_status === "available" && surah.edition ? surah.edition.title : null,
          tafsir: tafsirOn,
          ayahCount: summary.ayah_count,
          route: { surah: summary.number, name: summary.name_ar, sha256: surah.content_sha256 ?? null, version: surahVersion(surah) },
          focus: focus
            ? {
                surah: focus.surah,
                ayah: focus.ayah,
                name: names[focus.surah] ?? String(focus.surah),
                sha256: focusMatch?.content_sha256 ?? null,
                version: focusMatch ? surahVersion(focusMatch) : null,
              }
            : null,
        }
      : null,
  );
  const location = useLocation();
  const { record: saved } = useReadingState();
  const snap = useRef<{ n: number | null; anchor: string | null; saved: ReadingRecord | null; decision: RestoreDecision | null } | null>(
    null,
  );
  if (!snap.current || snap.current.n !== n) snap.current = { n, anchor: anchorFromHash(location.hash), saved, decision: null };
  if (snap.current.decision === null && surah !== null && n !== null && surah.number === n)
    snap.current.decision = restoreDecision(snap.current.anchor, snap.current.saved, { collection: "quran", id: String(n) }, surahSource(surah));
  const decision = snap.current.decision ?? { kind: "none" as const };
  const anchor = snap.current.anchor;
  const restore = useRestoreAnchor({
    ready: surah !== null && surah.number === n && decision.kind === "restore",
    recordKey: `quran|${n ?? ""}`,
    anchor: decision.kind === "restore" ? decision.anchor : null,
  });
  const fallback = decision.kind === "stale" ? "stale" : decision.kind === "missing" || restore === "missing" ? "missing" : null;
  const prev = index && pos > 0 ? index.surahs[pos - 1] : null;
  const next = index && pos >= 0 && pos < index.surahs.length - 1 ? index.surahs[pos + 1] : null;
  const keep = (num: number) => `/library/quran/${num}${browseSearch({ lang: locale, tafsir: tafsirOn })}`;
  const toggleTafsir = (on: boolean) =>
    setSearch(
      (prevParams) => {
        const p = new URLSearchParams(prevParams);
        if (on) p.set("tafsir", "1");
        else p.delete("tafsir");
        return p;
      },
      { replace: true },
    );

  return (
    <article className="bl-reader bl-quran space-y-5" data-testid="surah-reader" data-number={surah?.number ?? ""}>
      <div className="bl-readerbar">
        <BackLink to={listTo}>{t("library.quran.allSurahs")}</BackLink>
      </div>
      {indexRes.state?.status === "loading" && <LoadingLine>{t("library.quran.loadingList")}</LoadingLine>}
      {indexRes.state?.status === "error" && (
        <ErrorBox message={t("library.quran.listError")} onRetry={indexRes.retry} />
      )}
      {index && !summary && (
        <Notice testId="surah-missing">{t("library.quran.notDelivered", { number: isolate(name) })}</Notice>
      )}
      {summary && (
        <>
          <header className="space-y-1">
            <h1 className="bl-read__title">
              {t("library.quran.surahPrefix")} <bdi lang="ar" className="quote-ar">{summary.name_ar}</bdi>
            </h1>
            <p className="text-muted-foreground">
              {t("library.quran.surahMeta", { number: summary.number, count: summary.ayah_count })}
            </p>
          </header>
          <div className="bl-quran__controls">
          <ReadingLanguage value={locale} onChange={setLocale} />
          {tafsirKey && (
            <label className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                className="size-5"
                checked={tafsirOn}
                onChange={(e) => toggleTafsir(e.target.checked)}
                data-testid="tafsir-toggle"
              />
              <span>{t("library.quran.tafsirToggle")}</span>
            </label>
          )}
          </div>
          <QuranPlayer
            surah={summary.number}
            ayahCount={summary.ayah_count}
            names={names}
            onActive={(v) => {
              setActive(v);
              if (v) setFocus(v);
            }}
            onSelectAyah={(s, a) => {
              setFocus({ surah: s, ayah: a });
              setPendingSave({ surah: s, ayah: a });
            }}
            controller={player}
          />
          {focus && (
            <NowText
              focus={focus}
              res={focusRes}
              index={index}
              locale={locale}
              tafsirOn={tafsirOn}
              playing={active?.surah === focus.surah && active.ayah === focus.ayah}
            />
          )}
          <ReadingStoreNotice />
          {fallback === "stale" && <Notice testId="quran-restore-stale">{t("learn.readingPlace.stale")}</Notice>}
          {fallback === "missing" && anchor && (
            <Notice testId="quran-restore-missing">{t("audio.restoreMissing", { anchor })}</Notice>
          )}
          {state?.status === "loading" && (
            <LoadingLine>{t("library.quran.loading", { name: isolate(summary.name_ar) })}</LoadingLine>
          )}
          {state?.status === "error" && (
            <ErrorBox message={t("library.quran.error", { name: isolate(summary.name_ar) })} onRetry={retry} />
          )}
          {surah && (
            <div className="bl-quran__grid" data-testid="surah-body" data-locale={surah.locale}>
              <aside className="bl-reader__side bl-quran__side">
              <div className="bl-attrib-card space-y-2 text-sm">
                <p>{t("library.quran.arabicLabel")}</p>
                {surah.translation_status === "original" && <p>{t("library.quran.originalOnly")}</p>}
                {surah.translation_status === "available" && surah.edition && (
                  <>
                    <p className="flex flex-wrap items-center gap-x-3" data-testid="edition-line">
                      <span className="font-semibold">
                        {t("library.quran.editionLine", {
                          language: LOCALE_NAMES[locale],
                          title: isolate(surah.edition.title),
                          version: surah.edition.version ?? "—",
                        })}
                      </span>
                    </p>
                    <EditionCredits
                      edition={{
                        ...surah.edition,
                        description:
                          surah.edition.description ??
                          index?.editions.find((e) => e.key === surah.edition?.key)?.description,
                        browse_url:
                          surah.edition.browse_url ?? index?.editions.find((e) => e.key === surah.edition?.key)?.browse_url,
                      }}
                    />
                  </>
                )}
                <StatusNote />
              </div>
              {tafsirEntry && <TafsirCredit entry={tafsirEntry} />}
              <TechDetails
                rows={[
                  ["contentHash", surah.content_sha256],
                  ["edition", surah.edition?.key],
                  ["version", surah.edition?.version],
                  ["retrievedAt", surah.edition?.retrieved_at],
                  ["apiUrl", surah.edition?.api_template?.replace("{surah}", String(surah.number))],
                  ["metadata", surah.edition?.metadata_source],
                  ["arabicSource", index?.arabic.source],
                  ["tafsir", tafsirOn ? tafsirKey : null],
                ]}
              />
              </aside>
              <div className="bl-reader__main bl-quran__main">
              {surah.translation_status === "unavailable" && (
                <Notice testId="translation-unavailable">
                  {t("library.quran.translationUnavailable", { language: LOCALE_NAMES[locale] })}
                </Notice>
              )}
              <ol className="bl-qayahs">
                {surah.ayahs.map((a) => (
                  <li
                    key={a.aya}
                    id={`ayah-${a.aya}`}
                    className={`bl-qayah${active?.surah === surah.number && active.ayah === a.aya ? " is-active" : ""}`}
                    data-testid="ayah"
                    data-aya={a.aya}
                    data-active={active?.surah === surah.number && active.ayah === a.aya ? "true" : undefined}
                  >
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-muted-foreground">
                        {t("library.quran.ayah", { number: a.aya })}
                        {active?.surah === surah.number && active.ayah === a.aya && (
                          <span className="ms-2 text-primary">· {t("audio.nowPlayingHere")}</span>
                        )}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="inline-flex min-h-11 items-center rounded-md border border-input bg-background px-3 text-sm font-semibold hover:bg-muted"
                          onClick={() => player.current?.playAyah(a.aya)}
                          data-testid="ayah-listen"
                        >
                          {t("audio.listenFromAyah", { number: a.aya })}
                        </button>
                        {(() => {
                          const loc = placeOf(surah, a.aya, summary.name_ar, locale);
                          return loc ? <SavePlaceButton loc={loc} /> : null;
                        })()}
                      </div>
                    </div>
                    <ArabicBlock className="text-2xl leading-loose" testId="ayah-arabic">
                      <p>{a.arabic}</p>
                    </ArabicBlock>
                    {surah.translation_status === "available" && a.translation && (
                      <LocaleBlock locale={surah.locale} className="mt-3 text-lg" testId="ayah-translation">
                        <p className="whitespace-pre-line">{a.translation}</p>
                      </LocaleBlock>
                    )}
                    {surah.translation_status === "available" && a.footnotes && (
                      <div className="mt-3 border-s-4 border-border ps-3 text-sm" data-testid="ayah-footnote">
                        <p className="font-semibold">{t("library.quran.footnote")}</p>
                        <LocaleBlock locale={surah.locale}>
                          <p className="whitespace-pre-line">{a.footnotes}</p>
                        </LocaleBlock>
                      </div>
                    )}
                    {tafsirOn && a.tafsir && (
                      <div className="mt-3 rounded-md bg-muted p-3" data-testid="ayah-tafsir">
                        <p className="text-sm font-semibold">{t("library.quran.tafsirLabel")}</p>
                        <ArabicBlock className="mt-1 text-lg">
                          <p className="whitespace-pre-line">{a.tafsir}</p>
                        </ArabicBlock>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
              </div>
            </div>
          )}
          <nav aria-label={t("library.quran.surahNav")} className="flex flex-wrap justify-between gap-3 pt-2">
            {prev ? (
              <Link
                to={keep(prev.number)}
                className="inline-flex min-h-11 items-center rounded-md border border-input bg-card px-4 font-semibold no-underline hover:bg-muted"
                data-testid="surah-prev"
              >
                {t("library.quran.prev")}: <bdi lang="ar" className="ms-1">{prev.name_ar}</bdi>
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link
                to={keep(next.number)}
                className="inline-flex min-h-11 items-center rounded-md border border-input bg-card px-4 font-semibold no-underline hover:bg-muted"
                data-testid="surah-next"
              >
                {t("library.quran.next")}: <bdi lang="ar" className="ms-1">{next.name_ar}</bdi>
              </Link>
            )}
          </nav>
        </>
      )}
    </article>
  );
}
