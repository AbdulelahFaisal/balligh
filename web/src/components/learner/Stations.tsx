import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EvidenceQuotes, QuoteBlock, SourceCard, SourceLevelRefs, useSources } from "@/components/lesson";
import { useLearner } from "@/lib/learner";
import { sourcesForDraft } from "@/lib/teacherSource";
import { dirOf, type LessonCard, type LessonDraft } from "@/lib/types";
import type { DisplayStatus } from "@/lib/workspace";

type Ui = { lang: string; dir: "rtl" | "ltr" };

function SourcePassage({ card, draft }: { card: LessonCard; draft: LessonDraft }) {
  const { t } = useTranslation();
  const sources = sourcesForDraft(draft, useSources());
  const spans = card.source_span_ids.flatMap((id) => draft.spans.filter((s) => s.id === id));
  if (spans.length === 0) return null;
  const test = spans.some((s) => sources[s.source_id]?.is_test_data);
  return (
    <div className="bl-source" data-testid="card-source-passage" data-card-id={card.id}>
      <div className="bl-source__head">
        <h4 className="bl-source__title">{t("learner.fromSource")}</h4>
        <span className="bl-source__count">{t("source.label")}</span>
      </div>
      <div className="bl-source__body">
        {spans.map((sp) => {
          const rec = sources[sp.source_id];
          const lang = rec?.language ?? "ar";
          return (
            <div key={sp.id} className="bl-passage is-active" data-span-id={sp.id}>
              <span className="bl-passage__label">
                <bdi>{rec?.title ?? sp.source_id}</bdi> · {t("source.chars", { start: sp.start_offset, end: sp.end_offset })}
              </span>
              <p className="bl-passage__text quote-ar" lang={lang} dir={dirOf(lang)}>
                <mark className="bl-evidence">{sp.exact_text}</mark>
              </p>
            </div>
          );
        })}
      </div>
      {test && (
        <p className="bl-source__foot">
          <span className="bl-source__foot-mark" aria-hidden />
          {t("source.test")}
        </p>
      )}
    </div>
  );
}

export function ReadStation({ draft, ui, status }: { draft: LessonDraft; ui: Ui; status: DisplayStatus }) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const cards = draft.cards;
  const last = Math.max(0, cards.length - 1);
  const at = Math.min(index, last);
  const current = cards[at];
  return (
    <div className="bl-stage bl-stage--read">
      <div className="bl-sheet bl-paper bl-lx__paper" role="group" aria-label={t("learner.cards")}>
        {cards.map((c, i) => {
          const quotes = c.quote_id ? c.source_span_ids.flatMap((id) => draft.spans.filter((s) => s.id === id)) : [];
          return (
            <div key={c.id} hidden={i !== at} data-testid="lesson-card" data-card-id={c.id} data-current={i === at}>
              <p className="bl-paper__kicker" {...ui}>
                {t("learner.cardOf", { n: i + 1, total: cards.length })}
              </p>
              {quotes.map((q) => (
                <QuoteBlock key={q.id} text={q.exact_text} lang="ar" />
              ))}
              <p className="bl-paper__text">{c.text}</p>
              {c.editor_note && (
                <p className="bl-lx__note-line">
                  <span {...ui}>{t("review.note")}:</span> <bdi>{c.editor_note}</bdi>
                </p>
              )}
              <div className="bl-lx__card-foot" {...ui}>
                <div className="bl-lx__row">
                  <button type="button" className="bl-btn bl-btn--quiet" disabled aria-describedby={`listen-off-${c.id}`}>
                    {t("preview.listen")}
                  </button>
                  <span id={`listen-off-${c.id}`} className="bl-lx__muted">
                    {t("preview.listenOff")}
                  </span>
                </div>
                <SourceCard card={c} draft={draft} status={status} />
              </div>
            </div>
          );
        })}
        {cards.length > 1 && (
          <div className="bl-pager" {...ui}>
            <button
              type="button"
              className="bl-btn bl-btn--secondary"
              disabled={at === 0}
              onClick={() => setIndex(Math.max(0, at - 1))}
            >
              {t("learner.prevCard")}
            </button>
            <button
              type="button"
              className="bl-btn bl-btn--secondary"
              disabled={at >= last}
              onClick={() => setIndex(Math.min(last, at + 1))}
            >
              {t("learner.nextCard")}
            </button>
          </div>
        )}
      </div>
      <div className="bl-stage__source" {...ui}>
        {current && <SourcePassage card={current} draft={draft} />}
      </div>
    </div>
  );
}

export function TermsStation({ draft, ui }: { draft: LessonDraft; ui: Ui }) {
  const { t } = useTranslation();
  const learner = useLearner();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const opened = learner.progress?.terms ?? [];
  if (draft.terms.length === 0) return <p {...ui}>{t("learn.termsNone")}</p>;
  return (
    <>
      <p className="bl-lx__muted" {...ui}>
        {t("learn.termsHelp")}{" "}
        <span data-testid="terms-count">
          {t("learn.termsCount", { opened: opened.length, total: draft.terms.length })}
        </span>
      </p>
      <ul className="bl-understand bl-lx__terms">
        {draft.terms.map((term) => {
          const expanded = open.has(term.term_id);
          const panel = `term-panel-${term.term_id}`;
          return (
            <li
              key={term.term_id}
              className={`bl-term${expanded ? " is-open" : ""}`}
              data-testid={`learner-term-${term.term_id}`}
            >
              <button
                type="button"
                className="bl-term__trigger"
                aria-expanded={expanded}
                aria-controls={panel}
                onClick={() => {
                  setOpen((s) => {
                    const next = new Set(s);
                    if (expanded) next.delete(term.term_id);
                    else next.add(term.term_id);
                    return next;
                  });
                  if (!expanded) learner.openTerm(term.term_id);
                }}
              >
                <span className="bl-term__glyph" aria-hidden>
                  <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                    <path d="M12 6.5C10 5 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5C17 4.5 14 5 12 6.5Z" />
                    <path d="M12 6.5v13" />
                  </svg>
                </span>
                <span className="bl-term__words">
                  <span lang="ar" dir="rtl" className="bl-term__ar">
                    {term.source_form}
                  </span>{" "}
                  <bdi className="bl-term__en">({term.display_form})</bdi>
                </span>
                <span className="bl-term__hint" aria-hidden>
                  {expanded ? "−" : "+"}
                </span>
              </button>
              <div id={panel} hidden={!expanded} className="bl-term__meaning">
                <p>{term.meaning}</p>
                <div {...ui}>
                  <SourceLevelRefs sourceIds={term.source_ids} />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function ActivityStation({ draft, ui }: { draft: LessonDraft; ui: Ui }) {
  const { t } = useTranslation();
  const learner = useLearner();
  const a = draft.activity;
  const p = learner.progress;
  const checked = p?.checked && p.checked === p.choice ? p.checked : null;
  const correct = checked === a.correct_option_id;
  return (
    <div className="bl-quiz bl-lx__quiz" data-testid="learner-activity">
      <fieldset className="bl-lx__fieldset">
        <legend className="bl-quiz__prompt">{a.question}</legend>
        <div className="bl-quiz__choices">
          {a.options.map((o) => {
            const picked = p?.choice === o.id;
            const state = picked && checked ? (correct ? " is-right" : " is-wrong") : "";
            return (
              <label key={o.id} className={`bl-choice${state}`} data-option-id={o.id}>
                <input
                  type="radio"
                  name="activity"
                  className="bl-lx__radio"
                  checked={picked}
                  onChange={() => learner.choose(o.id)}
                />
                <span>{o.text}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="bl-lx__row bl-lx__quiz-actions" {...ui}>
        <button
          type="button"
          className="bl-btn bl-btn--primary"
          disabled={!p?.choice}
          onClick={() => learner.check(a.correct_option_id)}
        >
          {t("preview.try")}
        </button>
        {checked && (
          <button type="button" className="bl-btn bl-btn--secondary" onClick={learner.retry}>
            {t("preview.retry")}
          </button>
        )}
      </div>
      <div aria-live="polite" className="bl-feedback">
        {checked && correct && (
          <div className="bl-feedback__msg bl-feedback__msg--right" data-testid="activity-feedback" data-result="correct">
            <p {...ui}>
              <strong>{t("preview.correct")}</strong> {t("preview.why")}:
            </p>
            <p>{a.rationale}</p>
          </div>
        )}
        {checked && !correct && (
          <p className="bl-feedback__msg bl-feedback__msg--wrong" data-testid="activity-feedback" data-result="incorrect" {...ui}>
            {t("preview.wrong")}
          </p>
        )}
      </div>
      {checked && (
        <details className="bl-lx__evidence" data-testid="learner-evidence" {...ui}>
          <summary className="bl-reveal">{t("evidence.learnerShow")}</summary>
          <div className="bl-lx__evidence-body">
            <EvidenceQuotes draft={draft} spanIds={a.source_span_ids} />
          </div>
        </details>
      )}
    </div>
  );
}
