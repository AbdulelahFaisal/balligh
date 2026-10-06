import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { evidenceIndex, type AskReply, type Evidence } from "@/lib/assistant";
import { safeSourceUrl } from "@/lib/safeUrl";
import { LOCALE_NAMES, dirOf, type Locale } from "@/lib/types";

const languageName = (l: string) => LOCALE_NAMES[l as Locale] ?? l;
const internal = (href: string | null) => (href && href.startsWith("/") && !href.startsWith("//") ? href : null);

function jump(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ block: "nearest" });
  el.focus();
}

export function EvidenceItem({ item, domId, n }: { item: Evidence; domId: string; n: number }) {
  const { t } = useTranslation();
  const href = internal(item.href);
  const url = safeSourceUrl(item.url);
  const meta = [item.source.title, item.source.publisher, item.source.edition].filter((x): x is string => !!x);
  return (
    <li id={domId} tabIndex={-1} className="space-y-1 rounded-md border border-border bg-background p-2 text-sm" data-testid="assistant-evidence" data-kind={item.kind} data-evidence-id={item.id}>
      <p className="flex flex-wrap items-center gap-x-2 font-semibold">
        <span className="rounded bg-muted px-1.5 text-xs">{n}</span>
        <span>{t(`assistant.kind.${item.kind}`, { defaultValue: item.kind })}</span>
        {item.label && <bdi className="font-normal text-muted-foreground">{item.label}</bdi>}
      </p>
      <blockquote lang={item.lang} dir={item.dir === "rtl" || item.dir === "ltr" ? item.dir : dirOf(item.lang)} className="whitespace-pre-line border-s-4 border-border ps-2 text-start">
        {item.text}
      </blockquote>
      {meta.length > 0 && <p className="text-xs text-muted-foreground"><bdi>{meta.join(" · ")}</bdi></p>}
      <p className="flex flex-wrap gap-x-3">
        {href && (
          <Link to={href} className="font-semibold text-primary underline underline-offset-4" data-testid="assistant-evidence-link">
            {t("assistant.openInternal")}
          </Link>
        )}
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary underline underline-offset-4" data-testid="assistant-evidence-url">
            {t("assistant.openExternal")}
          </a>
        )}
      </p>
    </li>
  );
}

function QuranExtract({ reply, prefix }: { reply: AskReply; prefix: string }) {
  const { t } = useTranslation();
  const index = evidenceIndex(reply);
  const pick = (kind: Evidence["kind"]) => reply.evidence.filter((e) => e.kind === kind);
  const main = [...pick("quran_arabic"), ...pick("quran_translation"), ...pick("quran_footnote")];
  const tafsir = pick("quran_tafsir");
  const rest = reply.evidence.filter((e) => !main.includes(e) && !tafsir.includes(e));
  const editions = [...new Set(reply.evidence.map((e) => e.source.edition ?? (e.kind === "quran_translation" ? e.source.title : null)).filter((x): x is string => !!x))];
  const href = internal(reply.scope.href);
  return (
    <div className="space-y-2" data-testid="assistant-quran-extract">
      <p className="text-sm font-semibold text-primary" data-testid="assistant-extract-label">{t("assistant.extractLabel")}</p>
      <ol className="space-y-2">
        {[...main, ...rest].map((e) => (
          <EvidenceItem key={e.id} item={e} domId={`${prefix}-ev-${index.get(e.id)}`} n={(index.get(e.id) ?? 0) + 1} />
        ))}
      </ol>
      {editions.length > 0 && (
        <p className="text-xs" data-testid="assistant-edition-credit">
          {t("assistant.edition", { title: editions.join(" · ") })}
        </p>
      )}
      {tafsir.length > 0 && (
        <section className="space-y-1 rounded-md bg-muted p-2" aria-label={t("assistant.kind.quran_tafsir")} data-testid="assistant-tafsir">
          <p className="text-sm font-semibold">{t("assistant.kind.quran_tafsir")}</p>
          <ol className="space-y-2">
            {tafsir.map((e) => (
              <EvidenceItem key={e.id} item={e} domId={`${prefix}-ev-${index.get(e.id)}`} n={(index.get(e.id) ?? 0) + 1} />
            ))}
          </ol>
        </section>
      )}
      <p className="text-sm" data-testid="assistant-quran-note">{t("assistant.quranNote")}</p>
      {href && (
        <Link to={href} className="text-sm font-semibold text-primary underline underline-offset-4" data-testid="assistant-open-reader">
          {t("assistant.openReader")}
        </Link>
      )}
    </div>
  );
}

export function AssistantAnswer({ reply, prefix }: { reply: AskReply; prefix: string }) {
  const { t } = useTranslation();
  if (reply.status === "quran_extract" || reply.answer_kind === "published_extract") return <QuranExtract reply={reply} prefix={prefix} />;
  const index = evidenceIndex(reply);
  return (
    <div className="space-y-2" data-testid="assistant-answer" data-status={reply.status}>
      {reply.answer_kind === "ai_explanation" && (
        <p className="text-xs font-semibold text-accent" data-testid="assistant-ai-label">
          {t("assistant.aiLabel")} · {t("assistant.answerLanguage", { language: languageName(reply.locale) })}
        </p>
      )}
      {reply.status === "not_in_sources" && <p role="status" className="surface px-2 py-1 text-sm" data-testid="assistant-not-in-sources">{t("assistant.notInSources")}</p>}
      {reply.status === "needs_qualified_help" && <p role="status" className="surface px-2 py-1 text-sm" data-testid="assistant-needs-help">{t("assistant.needsHelp")}</p>}
      <div lang={reply.locale} dir={dirOf(reply.locale)} className="space-y-2 text-start">
        {reply.paragraphs.map((p, i) => (
          <p key={i} className="whitespace-pre-line" data-testid="assistant-paragraph">
            {p.text}
            {p.evidence
              .filter((id) => index.has(id))
              .map((id) => {
                const n = index.get(id)!;
                return (
                  <button
                    key={id}
                    type="button"
                    className="ms-1 inline-flex min-h-6 min-w-6 items-center justify-center rounded border border-input bg-card px-1 align-baseline text-xs font-semibold text-primary hover:bg-muted"
                    aria-label={t("assistant.cite", { n: n + 1 })}
                    onClick={() => jump(`${prefix}-ev-${n}`)}
                    data-testid="assistant-cite"
                    data-target={id}
                  >
                    {n + 1}
                  </button>
                );
              })}
          </p>
        ))}
      </div>
      {reply.evidence.length > 0 && (
        <section aria-label={t("assistant.evidenceTitle")} className="space-y-1">
          <p className="text-sm font-semibold">{t("assistant.evidenceTitle")}</p>
          <ol className="space-y-2">
            {reply.evidence.map((e, i) => (
              <EvidenceItem key={e.id} item={e} domId={`${prefix}-ev-${i}`} n={i + 1} />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
