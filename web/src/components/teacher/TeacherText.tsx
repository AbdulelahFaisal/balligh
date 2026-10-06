import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, type ApiError } from "@/lib/api";
import { LOCALE_NAMES, type Level, type Locale, type TeacherLimits } from "@/lib/types";
import type { GenerationOptions } from "@/lib/useGeneration";

const LOCALES: Locale[] = ["en", "ur", "zh-Hans", "id", "bn", "fr"];
const STORE = "balligh.teacherText.v1";
const ERRORS: Record<string, string> = {
  empty_text: "teach.error.empty",
  not_arabic: "teach.error.notArabic",
  too_many_words: "teach.error.tooLong",
  too_many_chars: "teach.error.tooLong",
  too_fragmented: "teach.error.fragmented",
};

type Saved = { text: string; title: string; reference: string };
type Quran = { matches: { surah: number; ayah: number }[]; markers: number; checked: boolean };
/** ok: storage read (possibly empty); unreadable: the read threw; corrupt: bytes exist but are not a saved form; write_failed. */
type Store = "ok" | "unreadable" | "corrupt" | "write_failed";
const EMPTY: Saved = { text: "", title: "", reference: "" };

// G5B-R03: an unreadable or damaged earlier draft is never replaced by an empty one.
function read(): { saved: Saved; store: Store } {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(STORE);
  } catch {
    return { saved: EMPTY, store: "unreadable" };
  }
  if (raw === null) return { saved: EMPTY, store: "ok" };
  try {
    const v = JSON.parse(raw);
    const optional = (x: unknown) => x === undefined || typeof x === "string";
    if (v && typeof v === "object" && typeof v.text === "string" && optional(v.title) && optional(v.reference))
      return { saved: { text: v.text, title: v.title ?? "", reference: v.reference ?? "" }, store: "ok" };
  } catch {
  }
  return { saved: EMPTY, store: "corrupt" };
}

/** Everything the next request depends on; a change invalidates any pending confirmation, retry or derive result. */
export const formRevision = (s: Saved, locale: Locale, level: Level) =>
  JSON.stringify([s.text, s.title, s.reference, locale, level]);

const countWords = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

export function TeacherText({
  locale,
  onLocale,
  level,
  onLevel,
  configured,
  running,
  onCreate,
  onLibrary,
  onRevision,
  status,
}: {
  locale: Locale;
  onLocale: (l: Locale) => void;
  level: Level;
  onLevel: (l: Level) => void;
  configured: boolean;
  running: boolean;
  onCreate: (options: GenerationOptions) => void;
  onLibrary: () => void;
  onRevision: (revision: string) => void;
  status: ReactNode;
}) {
  const { t } = useTranslation();
  const [initial] = useState(read);
  const [saved, setSaved] = useState<Saved>(initial.saved);
  const [store, setStore] = useState<Store>(initial.store);
  const edited = useRef(false);
  const [limits, setLimits] = useState<TeacherLimits | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quran, setQuran] = useState<Quran | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    api.teacherLimits().then(setLimits, () => setLimits(null));
    return () => inFlight.current?.abort();
  }, []);
  useEffect(() => {
    // Never write on mount, and never over bytes that could not be read until the teacher chooses.
    if (!edited.current || store === "unreadable" || store === "corrupt") return;
    try {
      sessionStorage.setItem(STORE, JSON.stringify(saved));
      if (store === "write_failed") setStore("ok");
    } catch {
      setStore("write_failed");
    }
  }, [saved, store]);
  const revision = formRevision(saved, locale, level);
  const liveRevision = useRef(revision);
  liveRevision.current = revision;
  useEffect(() => onRevision(revision), [revision, onRevision]);
  const retryRead = () => {
    const r = read();
    if (r.store === "ok") setSaved((cur) => (cur.text.trim() ? cur : r.saved));
    setStore(r.store);
  };
  const discardStored = () => {
    try {
      sessionStorage.removeItem(STORE);
      edited.current = true;
      setStore("ok");
      setSaved((cur) => ({ ...cur }));
    } catch {
      setStore("write_failed");
    }
  };

  const words = countWords(saved.text);
  const chars = saved.text.length;
  const over = !!limits && (words > limits.max_words || chars > limits.max_chars);
  const locked = busy || running;
  const update = (patch: Partial<Saved>) => {
    edited.current = true;
    setSaved((s) => ({ ...s, ...patch }));
    setError(null);
    setQuran(null);
  };

  async function create() {
    if (locked) return;
    if (!saved.text.trim()) return setError(t("teach.error.empty"));
    if (over && limits) return setError(t("teach.error.overLimit", { maxWords: limits.max_words, maxChars: limits.max_chars }));
    const abort = new AbortController();
    inFlight.current = abort;
    const startedAt = liveRevision.current;
    setBusy(true);
    setError(null);
    try {
      const d = await api.deriveTeacherSource(
        { title: saved.title, text: saved.text, declared_reference: saved.reference },
        abort.signal,
      );
      if (abort.signal.aborted || liveRevision.current !== startedAt) return; // G5B-R01: a late result for an older form is dropped
      setQuran(d.quran);
      onCreate({
        sourceId: d.snapshot.id,
        sourceVersion: d.snapshot.version,
        sourceSha256: d.snapshot.content_sha256,
        locale,
        level,
        teacherSource: d.snapshot,
      });
    } catch (e) {
      if (abort.signal.aborted) return;
      const err = e as ApiError;
      setError(err.status === 0 ? t("teach.error.network") : t((err.code && ERRORS[err.code]) || "teach.error.generic"));
    } finally {
      if (inFlight.current === abort) {
        inFlight.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <Card className="bl-teacher-prepare space-y-4" data-testid="teacher-prepare">
      {store !== "ok" && (
        <div role="status" className="rounded-md border border-accent bg-background p-3 text-sm" data-testid="teacher-store-notice" data-state={store}>
          <p>{t(`teach.store.${store === "write_failed" ? "writeFailed" : store}`)}</p>
          {store !== "write_failed" && (
            <p className="mt-2 flex flex-wrap gap-3">
              <button type="button" className="underline" data-testid="teacher-store-retry" onClick={retryRead}>
                {t("teach.store.retry")}
              </button>
              <button type="button" className="underline" data-testid="teacher-store-discard" onClick={discardStored}>
                {t("teach.store.discard")}
              </button>
            </p>
          )}
        </div>
      )}
      <label className="block space-y-2">
        <span className="text-lg font-semibold">{t("teach.textLabel")}</span>
        <textarea
          className="bl-teacher-text block w-full rounded-md border border-input bg-card p-3 text-lg leading-loose"
          lang="ar"
          dir="rtl"
          rows={9}
          value={saved.text}
          disabled={locked}
          placeholder={t("teach.textPlaceholder")}
          aria-describedby="teacher-count teacher-help"
          data-testid="teacher-text"
          onChange={(e) => update({ text: e.target.value })}
        />
      </label>
      <p id="teacher-count" className={over ? "text-sm font-semibold text-destructive" : "text-sm text-muted-foreground"} data-testid="teacher-count">
        {limits
          ? t("teach.count", { words, maxWords: limits.max_words, chars, maxChars: limits.max_chars })
          : t("teach.countPlain", { words, chars })}
      </p>
      <p id="teacher-help" className="text-sm text-muted-foreground">{t("teach.textHelp")}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-semibold">{t("setup.locale")}</span>
          <select
            className="mt-1 block min-h-10 w-full rounded-md border border-input bg-card px-2"
            value={locale}
            disabled={locked}
            data-testid="teacher-locale"
            onChange={(e) => onLocale(e.target.value as Locale)}
          >
            {LOCALES.map((l) => (
              <option key={l} value={l} lang={l}>
                {LOCALE_NAMES[l]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-semibold">{t("teach.titleLabel")}</span>
          <input
            className="mt-1 block min-h-10 w-full rounded-md border border-input bg-card px-2"
            value={saved.title}
            maxLength={limits?.max_title_chars ?? 120}
            disabled={locked}
            data-testid="teacher-title"
            onChange={(e) => update({ title: e.target.value })}
          />
        </label>
      </div>

      <details className="rounded-md border border-border p-3" data-testid="teacher-more">
        <summary className="cursor-pointer font-semibold">{t("teach.more")}</summary>
        <div className="mt-3 space-y-3">
          <label className="block text-sm">
            <span className="font-semibold">{t("teach.referenceLabel")}</span>
            <input
              className="mt-1 block min-h-10 w-full rounded-md border border-input bg-card px-2"
              value={saved.reference}
              maxLength={limits?.max_reference_chars ?? 300}
              disabled={locked}
              data-testid="teacher-reference"
              onChange={(e) => update({ reference: e.target.value })}
            />
            <span className="mt-1 block text-muted-foreground">{t("teach.referenceHelp")}</span>
          </label>
          <fieldset className="space-y-1 text-sm">
            <legend className="font-semibold">{t("setup.level")}</legend>
            {(["foundational", "detailed"] as Level[]).map((l) => (
              <label key={l} className="flex items-center gap-2">
                <input type="radio" name="teacher-level" checked={level === l} disabled={locked} onChange={() => onLevel(l)} />
                {t(`level.${l}`)}
              </label>
            ))}
          </fieldset>
        </div>
      </details>

      <p className="text-sm" data-testid="teacher-ai-notice">{t("teach.aiNotice")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="lg"
          disabled={!configured || locked}
          aria-busy={busy}
          data-testid="teacher-create"
          onClick={() => void create()}
        >
          {busy ? t("teach.creating") : t("teach.create")}
        </Button>
        {!configured && <span className="text-sm font-semibold">{t("setup.generateOff")}</span>}
      </div>
      {error && (
        <p role="alert" className="text-sm font-semibold" data-testid="teacher-error">
          {error}
        </p>
      )}
      {quran && (quran.matches.length > 0 || quran.markers > 0) && (
        <div role="note" className="rounded-md border border-accent bg-background p-3 text-sm" data-testid="teacher-quran">
          {quran.matches.length > 0 ? (
            <p>
              {t("teach.quranFound")}{" "}
              {quran.matches.map((m, i) => (
                <span key={`${m.surah}:${m.ayah}`}>
                  {i > 0 && " · "}
                  <Link className="underline" to={`/library/quran/${m.surah}?lang=${locale}`}>
                    {m.surah}:{m.ayah}
                  </Link>
                </span>
              ))}
            </p>
          ) : (
            <p>{t("teach.quranMaybe")}</p>
          )}
        </div>
      )}
      <div aria-live="polite">{status}</div>
      <p>
        <button type="button" className="text-sm underline" data-testid="library-toggle" disabled={locked} onClick={onLibrary}>
          {t("teach.libraryHeading")}
        </button>
      </p>
    </Card>
  );
}
