import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { MAX_QUESTION, quranTarget, type SourceScope } from "@/lib/assistant";
import { LOCALE_NAMES, dirOf, type Locale } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { AssistantAnswer } from "./AssistantAnswer";
import type { AssistantSession, Entry } from "./useAssistantSession";

const languageName = (l: string) => LOCALE_NAMES[l as Locale] ?? l;
const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),select:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])';

function ScopeLine({ scope, picked, fixed }: { scope: SourceScope | null; picked: number; fixed?: { surah: number; ayah: number } }) {
  const { t } = useTranslation();
  if (!scope) return <>{t("assistant.currentSite")}</>;
  if (scope.mode !== "quran")
    return <>{t(scope.mode === "fatwa" ? "assistant.currentFatwa" : "assistant.currentHadith", { title: scope.title })}</>;
  const target = fixed ?? quranTarget(scope, picked);
  return <>{t("assistant.currentQuran", { surah: target.surah, ayah: target.ayah, edition: scope.edition ?? t("assistant.arabicOnly") })}</>;
}

function ErrorLine({
  entry,
  canRetry,
  busy,
  onRetry,
}: {
  entry: Extract<Entry, { state: "error" }>;
  canRetry: boolean;
  busy: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const code = entry.error.code;
  const message =
    code === "not_configured"
      ? t("assistant.notConfigured")
      : code === "stale_context"
        ? t("assistant.stale")
        : code === "source_too_long"
          ? t("assistant.tooLong")
          : code === "busy" || code === "provider_busy"
            ? t("assistant.busy")
            : t("assistant.failed", { message: entry.error.message || String(entry.error.status) });
  const retry = entry.error.retryable && code !== "not_configured" && code !== "stale_context";
  return (
    <div role="alert" className="space-y-2 rounded-md border border-accent-soft bg-clay-wash p-2 text-sm" data-testid="assistant-error" data-code={code ?? ""}>
      <p>{message}</p>
      {retry && canRetry && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={busy} data-testid="assistant-retry">
          {t("assistant.retry")}
        </Button>
      )}
      {retry && !canRetry && (
        <p className="text-xs text-muted-foreground" data-testid="assistant-retry-stale">
          {t("assistant.retryStale")}
        </p>
      )}
    </div>
  );
}

function EntryView({ entry, session, latest }: { entry: Entry; session: AssistantSession; latest: boolean }) {
  const { t } = useTranslation();
  const prefix = `as-${entry.ticket.requestId.slice(0, 8)}`;
  return (
    <article className="space-y-2 rounded-lg border border-border bg-card p-3" data-testid={latest ? "assistant-current" : "assistant-history-item"} data-state={entry.state} data-request-id={entry.ticket.requestId}>
      <p className="text-xs text-muted-foreground">
        <ScopeLine scope={entry.scope} picked={1} fixed={entry.context && "ayah" in entry.context ? entry.context : undefined} />
      </p>
      <p className="text-sm">
        <span className="font-semibold">{t("assistant.you")}</span> <bdi className="whitespace-pre-line">{entry.question}</bdi>
      </p>
      {entry.state === "sending" && (
        <p role="status" className="text-sm text-muted-foreground" data-testid="assistant-sending">
          {t("assistant.sending")}
        </p>
      )}
      {entry.state === "cancelled" && (
        <p role="status" className="text-sm" data-testid="assistant-cancelled" data-reason={entry.reason}>
          {entry.reason === "user" ? t("assistant.cancelled") : t("assistant.stopped")}
        </p>
      )}
      {entry.state === "error" && (
        <ErrorLine entry={entry} canRetry={session.canRetry(entry)} busy={session.sending} onRetry={() => session.retry(entry)} />
      )}
      {entry.state === "answered" && <AssistantAnswer reply={entry.reply} prefix={prefix} />}
    </article>
  );
}

export function AssistantPanel({ session, onClose }: { session: AssistantSession; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const counterId = useId();
  const source = session.source;
  const current = session.choice === "source" ? source : null;
  const [latest, ...earlier] = session.entries;

  useEffect(() => {
    input.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const quran = current?.mode === "quran" ? current : null;

  return (
    <div className="fixed inset-0 z-40" lang={i18n.language} dir={dirOf(i18n.language)}>
      <div className="absolute inset-0 bg-foreground/30" aria-hidden="true" onClick={onClose} data-testid="assistant-backdrop" />
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-xl border border-border bg-background shadow-raised sm:inset-y-0 sm:start-auto sm:end-0 sm:max-h-none sm:w-[28rem] sm:rounded-none"
        data-testid="assistant-panel"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 id={titleId} className="text-lg font-bold">
            {t("assistant.title")}
          </h2>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} data-testid="assistant-close">
            {t("assistant.close")}
          </Button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <p className="text-sm text-muted-foreground">{t("assistant.intro")}</p>
          {session.teacherPage && (
            <p className="surface px-2 py-1 text-sm" data-testid="assistant-teacher-note">
              {t("assistant.scopeTeacher")}
            </p>
          )}
          <fieldset className="space-y-1">
            <legend className="text-sm font-semibold">{t("assistant.scopeLegend")}</legend>
            <label className="flex min-h-10 items-center gap-2 text-sm">
              <input type="radio" name="assistant-scope" className="size-4" checked={session.choice === "site"} onChange={() => session.setChoice("site")} data-testid="assistant-scope-site" />
              {t("assistant.scopeSite")}
            </label>
            {source && (
              <label className="flex min-h-10 items-center gap-2 text-sm">
                <input type="radio" name="assistant-scope" className="size-4" checked={session.choice === "source"} onChange={() => session.setChoice("source")} data-testid="assistant-scope-source" />
                {t("assistant.scopeSource")}
              </label>
            )}
          </fieldset>
          <div className="space-y-1 rounded-md border border-border bg-card p-2 text-sm" data-testid="assistant-scope" data-mode={current?.mode ?? "site_help"}>
            <p>
              <span className="font-semibold">{t("assistant.current")}</span>{" "}
              <bdi data-testid="assistant-scope-title">
                <ScopeLine scope={current} picked={session.picked} />
              </bdi>
            </p>
            <p data-testid="assistant-locale" data-locale={session.locale}>
              {t("assistant.answerLanguage", { language: languageName(session.locale) })}
            </p>
            {quran?.focus && (
              <p data-testid="assistant-quran-focus">
                {quran.focus.sha256 ? t("assistant.ayahFromReader", { name: quran.focus.name, ayah: quran.focus.ayah }) : t("assistant.ayahLoading")}
              </p>
            )}
            {quran && !quran.focus && (
              <label className="flex flex-wrap items-center gap-2">
                <span>{t("assistant.ayahPick", { name: quran.route.name })}</span>
                <select
                  className="min-h-10 rounded-md border border-input bg-background px-2"
                  value={session.picked}
                  onChange={(e) => session.setPicked(Number(e.target.value))}
                  data-testid="assistant-ayah"
                >
                  {Array.from({ length: quran.ayahCount }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              session.send();
            }}
          >
            <label className="block space-y-1">
              <span className="text-sm font-semibold">{t("assistant.question")}</span>
              <textarea
                ref={input}
                className="block min-h-24 w-full rounded-md border border-input bg-card p-2 text-base"
                maxLength={MAX_QUESTION}
                value={session.question}
                onChange={(e) => session.setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    session.send();
                  }
                }}
                aria-describedby={counterId}
                data-testid="assistant-question"
              />
            </label>
            <p id={counterId} className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span data-testid="assistant-empty">{session.question.trim() === "" ? t("assistant.empty") : ""}</span>
              <span data-testid="assistant-counter">{t("assistant.counter", { count: session.question.length, max: MAX_QUESTION })}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={!session.canSend} data-testid="assistant-send">
                {t("assistant.send")}
              </Button>
              {session.sending && (
                <Button type="button" variant="outline" onClick={session.cancel} data-testid="assistant-cancel">
                  {t("assistant.cancel")}
                </Button>
              )}
            </div>
          </form>
          {latest && <EntryView key={latest.ticket.requestId} entry={latest} session={session} latest />}
          {earlier.length > 0 && (
            <section className="space-y-2" aria-label={t("assistant.history")} data-testid="assistant-history">
              <p className="text-sm font-semibold">{t("assistant.history")}</p>
              <p className="text-xs text-muted-foreground">{t("assistant.historyNote")}</p>
              {earlier.map((e) => (
                <EntryView key={e.ticket.requestId} entry={e} session={session} latest={false} />
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
