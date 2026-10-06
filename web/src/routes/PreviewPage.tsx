import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ImportButton, StatusBadge } from "@/components/lesson";
import { AuthorTools } from "@/components/learner/AuthorTools";
import { ActivityStation, ReadStation, TermsStation } from "@/components/learner/Stations";
import { useLearner } from "@/lib/learner";
import { isLive } from "@/lib/provenance";
import { dirOf, type LessonDraft } from "@/lib/types";
import { useWorkspace } from "@/lib/workspace";

const STATIONS = ["st-read", "st-term", "st-try"] as const;
type Station = (typeof STATIONS)[number];

function goTo(station: Station) {
  const heading = document.getElementById(station);
  heading?.scrollIntoView({ block: "start" });
  heading?.focus({ preventScroll: true });
}

function useNames(): Record<Station, string> {
  const { t } = useTranslation();
  return { "st-read": t("preview.read"), "st-term": t("preview.term"), "st-try": t("preview.try") };
}

function StationRail({ done, current, onGo }: { done: Record<Station, boolean>; current: Station; onGo: (s: Station) => void }) {
  const { t } = useTranslation();
  const names = useNames();
  return (
    <nav className="bl-lx__rail" aria-label={t("learn.stations")} data-testid="station-nav">
      <ol className="bl-lx__steps">
        {STATIONS.map((s, i) => (
          <li key={s}>
            <a
              href={`#${s}`}
              className={`bl-rail__step bl-lx__step${s === current ? " is-current" : ""}`}
              aria-current={s === current ? "step" : undefined}
              data-done={done[s]}
              onClick={(e) => {
                e.preventDefault();
                onGo(s);
              }}
            >
              <span className="bl-rail__num" aria-hidden>
                {done[s] ? "✓" : i + 1}
              </span>
              <span className="bl-rail__label">
                <span>
                  {i + 1} · {names[s]}
                </span>
                <span className="bl-lx__step-state">{done[s] ? `✓ ${t("learn.done")}` : t("learn.notYet")}</span>
              </span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function ProgressSummary({ draft, done, onGo }: { draft: LessonDraft; done: Record<Station, boolean>; onGo: (s: Station) => void }) {
  const { t } = useTranslation();
  const learner = useLearner();
  const names = useNames();
  const p = learner.progress;
  const count = STATIONS.filter((s) => done[s]).length;
  const tried = Boolean(p?.checked) || Boolean(p?.solved);
  const lines: Record<Station, string> = {
    "st-read": p?.read ? t("learn.summary.read") : t("learn.summary.notRead"),
    "st-term":
      draft.terms.length === 0
        ? t("learn.termsNone")
        : t("learn.termsCount", { opened: p?.terms.length ?? 0, total: draft.terms.length }),
    "st-try": p?.solved ? t("learn.summary.solved") : tried ? t("learn.summary.tried") : t("learn.summary.notAnswered"),
  };
  return (
    <section
      aria-labelledby="progress-title"
      className="bl-lx__progress"
      data-testid="progress-summary"
      data-complete={count === 3}
    >
      <h2 id="progress-title" className="bl-station__title">
        {t("learn.summaryTitle")}
      </h2>
      <div className="bl-lx__progress-card">
        <p className="bl-lx__strong" data-testid="progress-count">
          {count === 3 ? t("learn.complete") : t("learn.completedCount", { done: count })}
        </p>
        <ul className="bl-lx__progress-list">
          {STATIONS.map((s) => (
            <li key={s} data-testid={`progress-${s}`} data-done={done[s]}>
              <span aria-hidden className={done[s] ? "bl-lx__ok" : "bl-lx__muted"}>
                {done[s] ? "✓" : "○"}
              </span>
              <span className="bl-lx__strong">{names[s]}:</span>
              <span>{lines[s]}</span>
              <a
                href={`#${s}`}
                className="bl-lx__link"
                onClick={(e) => {
                  e.preventDefault();
                  onGo(s);
                }}
              >
                {t("learn.revisit", { station: names[s] })}
              </a>
            </li>
          ))}
        </ul>
        <p className="bl-lx__muted">{t("learn.localNote")}</p>
        <p data-testid="progress-storage" data-mode={learner.mode}>
          {t(`learn.storage.${learner.mode}`)}
        </p>
        {learner.resetFailed && (
          <p className="bl-lx__alert" data-testid="progress-reset-failed">
            {t("learn.resetFailed")}
          </p>
        )}
        <div>
          <button type="button" className="bl-btn bl-btn--secondary" onClick={learner.reset}>
            {t("learn.reset")}
          </button>
        </div>
      </div>
    </section>
  );
}

export function PreviewPage() {
  const { t, i18n } = useTranslation();
  const ws = useWorkspace();
  const learner = useLearner();
  const [current, setCurrent] = useState<Station>("st-read");
  const ui = { lang: i18n.language, dir: dirOf(i18n.language) };
  const draft = ws.draft;
  if (!draft) {
    return (
      <div className="space-y-3">
        <p>
          {t("preview.empty")} <Link to="/setup" className="text-primary underline">{t("nav.setup")}</Link>
        </p>
        <ImportButton />
      </div>
    );
  }
  const status = ws.displayStatus;
  const loc = draft.target_locale;
  const scale = draft.presentation.font_scale;
  const setScale = (s: number) =>
    ws.updateDraft((d) => ({ ...d, presentation: { font_scale: Math.min(2, Math.max(0.75, Math.round(s * 100) / 100)) } }));
  const p = learner.progress;
  const done: Record<Station, boolean> = {
    "st-read": Boolean(p?.read),
    "st-term": draft.terms.length === 0 || (p?.terms.length ?? 0) > 0,
    "st-try": Boolean(p?.solved),
  };
  const go = (s: Station) => {
    setCurrent(s);
    goTo(s);
  };
  const names = { "st-read": t("preview.read"), "st-term": t("preview.term"), "st-try": t("preview.try") };

  return (
    <section className="bl-lx" aria-labelledby="preview-title">
      <StationRail done={done} current={current} onGo={go} />
      <div className="bl-lx__main">
        <header className="bl-lx__head">
          <div className="bl-lx__heading">
            <h1 id="preview-title" className="bl-lx__eyebrow">
              {t("preview.title")}
            </h1>
            <StatusBadge status={status} />
          </div>
          <div className="bl-lx__row" role="group" aria-label={t("preview.fontSize")}>
            <span className="bl-lx__muted">{t("preview.fontSize")}</span>
            <button type="button" className="bl-btn bl-btn--tool" aria-label={t("preview.smaller")} onClick={() => setScale(scale - 0.125)}>
              A−
            </button>
            <button type="button" className="bl-btn bl-btn--tool" aria-label={t("preview.larger")} onClick={() => setScale(scale + 0.125)}>
              A+
            </button>
          </div>
        </header>

        <div className="bl-lx__notices">
          {isLive(draft.generation) && (
            <p className="bl-lx__notice bl-lx__notice--ai" data-testid="ai-draft-banner">
              {t("preview.aiDraft")}
            </p>
          )}
          <p className="bl-lx__notice" data-testid="review-notice">
            {status === "acknowledged_by_user" && ws.review
              ? t("learn.reviewNoticeAck", { label: ws.review.reviewer_label })
              : status === "team_published"
                ? t("status.team_published")
                : t("learn.reviewNoticeDraft")}
          </p>
          {!ws.recovery && !ws.saveFailed && (
            <p className="bl-lx__muted">
              <span data-testid="storage-note">{t("storage.note")}</span>
            </p>
          )}
        </div>

        <article
          key={learner.lessonKey ?? "none"}
          lang={loc}
          dir={dirOf(loc)}
          style={{ fontSize: `${scale}rem` }}
          className="bl-lx__lesson"
          data-testid="lesson"
        >
          <h2 className="bl-learn__title bl-lx__title">{draft.title}</h2>

          <section aria-labelledby="st-read" className="bl-station bl-lx__station">
            <h3 id="st-read" tabIndex={-1} {...ui} className="bl-station__title">
              <span className="bl-station__num">1</span>
              {" "}{names["st-read"]}
            </h3>
            <ReadStation draft={draft} ui={ui} status={status} />
            <div className="bl-lx__row bl-lx__actions" {...ui}>
              <button
                type="button"
                className={`bl-btn ${p?.read ? "bl-btn--primary" : "bl-btn--secondary"}`}
                aria-pressed={Boolean(p?.read)}
                data-testid="mark-read"
                onClick={() => learner.markRead(!p?.read)}
              >
                {p?.read ? "✓ " : ""}
                {t("learn.markRead")}
              </button>
              <button type="button" className="bl-btn bl-btn--quiet" onClick={() => go("st-term")}>
                {t("learn.nextTerms")}
              </button>
            </div>
          </section>

          <section aria-labelledby="st-term" className="bl-station bl-lx__station">
            <h3 id="st-term" tabIndex={-1} {...ui} className="bl-station__title">
              <span className="bl-station__num">2</span>
              {" "}{names["st-term"]}
            </h3>
            <TermsStation draft={draft} ui={ui} />
            <div className="bl-lx__row bl-lx__actions" {...ui}>
              <button type="button" className="bl-btn bl-btn--quiet" onClick={() => go("st-try")}>
                {t("learn.nextQuestion")}
              </button>
            </div>
          </section>

          <section aria-labelledby="st-try" className="bl-station bl-lx__station">
            <h3 id="st-try" tabIndex={-1} {...ui} className="bl-station__title">
              <span className="bl-station__num">3</span>
              {" "}{names["st-try"]}
            </h3>
            <ActivityStation draft={draft} ui={ui} />
          </section>
        </article>
        <ProgressSummary draft={draft} done={done} onGo={go} />
        <AuthorTools />
      </div>
    </section>
  );
}
