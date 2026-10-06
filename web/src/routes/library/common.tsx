import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { dirOf, LOCALE_NAMES, LOCALES, type Locale } from "@/lib/types";
import {
  HAS_PRIVATE_USE,
  HONORIFIC_GLYPHS,
  isLocale,
  publisherHost,
  publisherUrl,
  runKey,
  splitGlyphs,
  type Note,
  type NoteLinks,
  type Paragraph,
  type QuranEdition,
  type QuranTafsir,
} from "@/lib/library";
import { cn } from "@/lib/utils";

export const isolate = (s: string) => `⁨${s}⁩`;

export function useReadingLocale(): [Locale, (next: Locale) => void] {
  const { i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get("lang");
  const locale: Locale = isLocale(fromUrl) ? fromUrl : isLocale(i18n.language) ? i18n.language : "ar";
  const set = (next: Locale) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set("lang", next);
        return p;
      },
      { replace: true },
    );
  return [locale, set];
}

export function ReadingLanguage({ value, onChange }: { value: Locale; onChange: (l: Locale) => void }) {
  const { t } = useTranslation();
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
      <p className="text-sm text-muted-foreground">{t("library.readingLanguageHint")}</p>
    </div>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex min-h-11 items-center gap-1 rounded-md px-1 font-semibold text-primary underline-offset-4 hover:underline"
      data-testid="back-link"
    >
      <span aria-hidden="true" className="rtl:rotate-180">
        ←
      </span>
      {children}
    </Link>
  );
}

export function SourceLink({ url, children }: { url: string | null | undefined; children?: ReactNode }) {
  const { t } = useTranslation();
  const href = publisherUrl(url);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-4"
      data-testid="source-link"
    >
      {children ?? t("library.openSource", { host: publisherHost(href) })}
    </a>
  );
}

export function useDateLabel() {
  const { i18n } = useTranslation();
  return (iso: string | null | undefined): string | null => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    try {
      return new Intl.DateTimeFormat(i18n.language, { dateStyle: "long", timeZone: "UTC" }).format(d);
    } catch {
      return iso.slice(0, 10);
    }
  };
}

export function Credit({
  label,
  url,
  linkText,
  retrievedAt,
}: {
  label: string;
  url: string | null | undefined;
  linkText?: ReactNode;
  retrievedAt?: string | null;
}) {
  const { t } = useTranslation();
  const date = useDateLabel()(retrievedAt);
  return (
    <p className="flex flex-wrap items-center gap-x-3 text-sm" data-testid="credit">
      <bdi className="font-semibold">{label}</bdi>
      <SourceLink url={url}>{linkText}</SourceLink>
      {date && <span>{t("library.retrieved", { date })}</span>}
    </p>
  );
}

export function StatusNote() {
  const { t } = useTranslation();
  return (
    <p className="rounded-md bg-muted px-3 py-2 text-sm" data-testid="status-note">
      {t("library.statusNote")}
    </p>
  );
}

export function Notice({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="rounded-lg border-2 border-accent-soft bg-card px-3 py-2 font-semibold" data-testid={testId}>
      {children}
    </p>
  );
}

export function LoadingLine({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="py-6 text-lg text-muted-foreground" data-testid="library-loading">
      {children}
    </p>
  );
}

export function ErrorBox({ message, onRetry }: { message: ReactNode; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="rounded-lg border-2 border-accent bg-card p-3" data-testid="library-error">
      <p className="font-semibold">{message}</p>
      <Button variant="outline" className="mt-2 min-h-11" onClick={onRetry}>
        {t("library.retry")}
      </Button>
    </div>
  );
}

export function ArabicBlock({ className, children, testId }: { className?: string; children: ReactNode; testId?: string }) {
  return (
    <div lang="ar" dir="rtl" className={cn("quote-ar text-start", className)} data-testid={testId}>
      {children}
    </div>
  );
}

export function LocaleBlock({
  locale,
  className,
  children,
  testId,
}: {
  locale: string;
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div lang={locale} dir={dirOf(locale)} className={cn("text-start", className)} data-testid={testId}>
      {children}
    </div>
  );
}

function RunText({ text, honorifics }: { text: string; honorifics?: boolean }) {
  const { t } = useTranslation();
  if (!HAS_PRIVATE_USE.test(text)) return <>{text}</>;
  const label = t("library.honorificLabel");
  const title = t("library.honorificText");
  return (
    <>
      {splitGlyphs(text, honorifics ? HONORIFIC_GLYPHS : null).map((part, i) =>
        part.kind === "text" ? (
          <span key={i}>{part.text}</span>
        ) : part.kind === "honorific" ? (
          <span
            key={i}
            lang="ar"
            dir="rtl"
            title={title}
            className="font-normal text-muted-foreground"
            data-glyph={part.code}
            data-testid="honorific-text"
          >
            {part.text}
          </span>
        ) : (
          <span
            key={i}
            role="img"
            aria-label={label}
            title={label}
            className="mx-0.5 align-middle text-sm font-normal text-muted-foreground"
            data-glyph={part.code}
            data-testid="honorific-marker"
          >
            ◌
          </span>
        ),
      )}
    </>
  );
}

function NoteRef({ text, link }: { text: string; link: { href: string; id: string | null } }) {
  const { t } = useTranslation();
  return (
    <sup>
      <a
        href={link.href}
        id={link.id ?? undefined}
        aria-label={t("library.notes.ref", { label: text })}
        className="scroll-mt-24 rounded px-0.5 font-semibold text-primary underline underline-offset-2"
        data-testid="noteref"
      >
        {text}
      </a>
    </sup>
  );
}

export function Runs({
  paragraphs,
  className,
  honorifics,
  links,
  group = 0,
}: {
  paragraphs: Paragraph[];
  className?: string;
  honorifics?: boolean;
  links?: NoteLinks | null;
  group?: number;
}) {
  return (
    <div className={cn("space-y-3", className)}>
      {paragraphs.map((para, i) => (
        <p key={i} className="whitespace-pre-line">
          {para.map((run, j) => {
            const body = <RunText text={run.text} honorifics={honorifics} />;
            if (run.kind === "noteref") {
              const link = links?.refs[runKey(group, i, j)];
              return link ? <NoteRef key={j} text={run.text} link={link} /> : <span key={j}>{body}</span>;
            }
            return run.kind === "strong" ? (
              <strong key={j}>{body}</strong>
            ) : run.kind === "quran" ? (
              <span key={j} className="font-semibold text-primary" data-run="quran">
                {body}
              </span>
            ) : run.kind === "hadith" ? (
              <span key={j} className="font-semibold text-accent" data-run="hadith">
                {body}
              </span>
            ) : (
              <span key={j}>{body}</span>
            );
          })}
        </p>
      ))}
    </div>
  );
}

export function NotesList({
  recordId,
  notes,
  links,
  honorifics,
}: {
  recordId: string;
  notes: Note[] | null | undefined;
  links: NoteLinks;
  honorifics?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const shown = (Array.isArray(notes) ? notes : []).filter(
    (n, i, all) => n && typeof n.id === "string" && Array.isArray(n.runs) && all.findIndex((m) => m?.id === n.id) === i,
  );
  if (shown.length === 0) return null;
  const headingId = `notes-${recordId}`;
  return (
    <section className="mt-6 border-t border-border pt-4" aria-labelledby={headingId} data-testid="fatwa-notes">
      <h3 id={headingId} className="mb-2 text-lg font-semibold">
        {t("library.notes.title")}
      </h3>
      <ArabicBlock className="text-lg leading-loose">
        <ol className="list-none space-y-3 ps-0" data-testid="note-list">
          {shown.map((n) => {
            const back = links.backs[n.id];
            return (
              <li
                key={n.id}
                id={links.targets[n.id]}
                className="scroll-mt-24 rounded-md target:bg-muted"
                data-testid="note"
                data-note={n.id}
              >
                <span className="me-2 font-semibold" data-testid="note-number">
                  [{n.id}]
                </span>
                <Runs paragraphs={[n.runs]} honorifics={honorifics} className="inline [&>p]:inline" />
                {back && (
                  <a
                    href={`#${back}`}
                    lang={i18n.language}
                    dir={dirOf(i18n.language)}
                    className="ms-2 inline-flex min-h-11 items-center text-sm font-semibold text-primary underline underline-offset-4"
                    data-testid="note-back"
                  >
                    {t("library.notes.back", { id: n.id })}
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      </ArabicBlock>
    </section>
  );
}

const KING_FAHD = "King Fahd Quran Printing Complex";

export function EditionCredits({ edition, testPrefix = "edition" }: { edition: QuranEdition; testPrefix?: string }) {
  const { t } = useTranslation();
  return (
    <>
      {edition.description && (
        <p className="flex flex-wrap items-baseline gap-x-2" data-testid={`${testPrefix}-description`}>
          <span className="font-semibold">{t("library.credits.statement")}</span>
          <bdi lang="en" dir="ltr" data-testid={`${testPrefix}-description-text`}>
            {edition.description}
          </bdi>
        </p>
      )}
      <p className="flex flex-wrap items-center gap-x-2" data-testid={`${testPrefix}-provider`}>
        <span className="font-semibold">{t("library.credits.provider")}</span>
        <SourceLink url={edition.browse_url}>QuranEnc.com</SourceLink>
      </p>
    </>
  );
}

export function TafsirCredit({ entry }: { entry: QuranTafsir }) {
  const { t } = useTranslation();
  const publisher = entry.original_publisher
    ? entry.original_publisher === KING_FAHD
      ? t("library.credits.kingFahd")
      : entry.original_publisher
    : null;
  return (
    <div className="space-y-1 text-sm" data-testid="tafsir-credit">
      <p className="flex flex-wrap items-center gap-x-2">
        <span className="font-semibold">{t("library.credits.tafsirTitle")}</span>
        {entry.version && <span>{t("library.quran.versionShort", { version: entry.version })}</span>}
      </p>
      {publisher && (
        <p data-testid="tafsir-publisher">
          <bdi>{t("library.credits.originalPublisher", { publisher })}</bdi>
        </p>
      )}
      <p className="flex flex-wrap items-center gap-x-2" data-testid="tafsir-provider">
        <span>{t("library.credits.delivered")}</span>
        <SourceLink url={entry.browse_url}>QuranEnc.com</SourceLink>
      </p>
    </div>
  );
}

export function TechDetails({
  rows,
  extra = [],
}: {
  rows: [string, string | number | null | undefined][];
  extra?: [string, string, string?][];
}) {
  const { t } = useTranslation();
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (shown.length === 0 && extra.length === 0) return null;
  return (
    <details className="mt-8 rounded-lg border border-border bg-card p-3 text-sm" data-testid="tech-details">
      <summary className="min-h-10 cursor-pointer py-2 font-semibold">{t("library.tech.title")}</summary>
      <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
        {shown.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-semibold">{t(`library.tech.${k}`)}</dt>
            <dd dir="ltr" className="text-start font-mono text-xs break-all">
              {String(v)}
            </dd>
          </div>
        ))}
        {extra.map(([label, value, testId]) => (
          <div key={label} className="contents">
            <dt className="font-semibold">{label}</dt>
            <dd className="text-start" data-testid={testId ?? "tech-extra"}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function TopicLabel({ topic }: { topic: string }) {
  const { t } = useTranslation();
  return <>{t(`library.topics.${topic}`, { defaultValue: topic })}</>;
}

export function useReaderAnchor(anchors: string[]): string | null {
  const list = anchors.join("|");
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    const ids = list ? list.split("|") : [];
    if (ids.length === 0) return;
    let frame = 0;
    const pick = () => {
      frame = 0;
      const els = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null);
      if (els.length === 0) return;
      const line = window.innerHeight * 0.35;
      const atEnd = window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
      let chosen = els[0];
      for (const el of els) {
        const top = el.getBoundingClientRect().top;
        if (top <= line || (atEnd && top < window.innerHeight)) chosen = el;
      }
      setCurrent(chosen.id);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(pick);
    };
    const focused = (e: FocusEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      const hit = ids.find((id) => document.getElementById(id)?.contains(target));
      if (hit) setCurrent(hit);
    };
    pick();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", focused);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", focused);
    };
  }, [list]);
  return current !== null && anchors.includes(current) ? current : (anchors[0] ?? null);
}
