import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EvidenceQuotes, OriginalText, QuoteBlock, SourceCard, SourceLevelRefs, StatusBadge } from "@/components/lesson";
import { OriginPanel } from "@/components/OriginPanel";
import { EvidenceRelation, ReviewOutline, type OutlineItem } from "@/components/review/ReviewParts";
import { ApiError } from "@/lib/api";
import { markHumanEdit } from "@/lib/provenance";
import { emptyFields, semanticKey, type FieldPath } from "@/lib/semantic";
import { dirOf, type LessonActivity, type LessonCard, type LessonDraft, type LessonTerm } from "@/lib/types";
import { useWorkspace } from "@/lib/workspace";

export function useMediaQuery(q: string) {
  const [match, setMatch] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setMatch(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [q]);
  return match;
}

const inputClass =
  "mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring aria-[invalid=true]:border-accent aria-[invalid=true]:border-2";

const fieldId = (path: FieldPath) => `err-${path.replace(/[^A-Za-z0-9_-]/g, "-")}`;

function useField(problems: Set<FieldPath>, path: FieldPath) {
  const invalid = problems.has(path);
  return {
    invalid,
    props: { "aria-invalid": invalid, "aria-describedby": invalid ? fieldId(path) : undefined },
  };
}

function FieldError({ path, problems }: { path: FieldPath; problems: Set<FieldPath> }) {
  const { t } = useTranslation();
  if (!problems.has(path)) return null;
  return (
    <p id={fieldId(path)} className="mt-1 text-sm font-semibold text-accent" data-testid="field-error">
      {t("review.emptyField")}
    </p>
  );
}

function CardEditor({
  card,
  index,
  draft,
  active,
  problems,
  selected,
  onFocus,
  onJump,
}: {
  card: LessonCard;
  index: number;
  draft: LessonDraft;
  active: boolean;
  problems: Set<FieldPath>;
  selected: boolean;
  onFocus: () => void;
  onJump: () => void;
}) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const quotes = card.quote_id ? card.source_span_ids.flatMap((id) => draft.spans.filter((s) => s.id === id)) : [];
  const text = useField(problems, `card:${card.id}:text`);
  const set = (patch: Partial<LessonCard>) =>
    ws.updateDraft((d) => markHumanEdit({ ...d, cards: d.cards.map((c) => (c.id === card.id ? { ...c, ...patch } : c)) }));
  return (
    <Card
      id={`rv-item-card-${card.id}`}
      tabIndex={-1}
      className={`rv-editor${selected ? " rv-editor--selected" : ""}${active ? " ring-2 ring-primary" : ""}`}
      data-selected={selected}
      onFocusCapture={onFocus}
    >
      <h3 id={`rv-head-card-${card.id}`} className="rv-editor__head mb-2 font-semibold">
        {t("review.card", { n: index + 1 })}
      </h3>
      {quotes.length > 0 && (
        <>
          <p className="text-sm text-muted-foreground">{t("review.quote")}</p>
          {quotes.map((q) => (
            <QuoteBlock key={q.id} text={q.exact_text} lang="ar" />
          ))}
        </>
      )}
      <label className="block">
        <span className="text-sm font-semibold">{t("review.cardText")}</span>
        <textarea
          className={inputClass}
          rows={3}
          lang={draft.target_locale}
          dir={dirOf(draft.target_locale)}
          value={card.text}
          maxLength={2000}
          data-testid={`card-text-${card.id}`}
          {...text.props}
          onChange={(e) => set({ text: e.target.value })}
        />
      </label>
      <FieldError path={`card:${card.id}:text`} problems={problems} />
      <EvidenceRelation draft={draft} spanIds={card.source_span_ids} describedBy={`rv-head-card-${card.id}`} onJump={onJump} />
      <label className="mt-2 block">
        <span className="text-sm font-semibold">{t("review.note")}</span>
        <textarea
          className={inputClass}
          rows={2}
          dir="auto"
          value={card.editor_note}
          maxLength={1000}
          data-testid={`card-note-${card.id}`}
          onChange={(e) => set({ editor_note: e.target.value })}
        />
      </label>
      <SourceCard card={card} draft={draft} status={ws.displayStatus} />
    </Card>
  );
}

function TermEditor({ term, draft, problems }: { term: LessonTerm; draft: LessonDraft; problems: Set<FieldPath> }) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const display = useField(problems, `term:${term.term_id}:display_form`);
  const meaning = useField(problems, `term:${term.term_id}:meaning`);
  const set = (patch: Partial<LessonTerm>) =>
    ws.updateDraft((d) =>
      markHumanEdit({ ...d, terms: d.terms.map((x) => (x.term_id === term.term_id ? { ...x, ...patch } : x)) }),
    );
  return (
    <div className="border-t border-border pt-3 first:border-t-0 first:pt-0" data-testid={`term-editor-${term.term_id}`}>
      <p className="text-sm text-muted-foreground">{t("review.termSource")}</p>
      <p lang="ar" dir="rtl" className="quote-ar text-lg font-semibold" data-testid="term-source-form">
        {term.source_form}
      </p>
      <label className="mt-2 block">
        <span className="text-sm font-semibold">{t("review.termDisplay")}</span>
        <input
          className={inputClass}
          value={term.display_form}
          maxLength={120}
          lang={draft.target_locale}
          dir={dirOf(draft.target_locale)}
          data-testid={`term-display-${term.term_id}`}
          {...display.props}
          onChange={(e) => set({ display_form: e.target.value })}
        />
      </label>
      <FieldError path={`term:${term.term_id}:display_form`} problems={problems} />
      <label className="mt-2 block">
        <span className="text-sm font-semibold">{t("review.termMeaning")}</span>
        <textarea
          className={inputClass}
          rows={2}
          value={term.meaning}
          maxLength={600}
          lang={draft.target_locale}
          dir={dirOf(draft.target_locale)}
          data-testid={`term-meaning-${term.term_id}`}
          {...meaning.props}
          onChange={(e) => set({ meaning: e.target.value })}
        />
      </label>
      <FieldError path={`term:${term.term_id}:meaning`} problems={problems} />
      <div className="mt-2">
        <SourceLevelRefs sourceIds={term.source_ids} />
      </div>
    </div>
  );
}

function ActivityEditor({
  draft,
  problems,
  active,
  selected,
  onFocus,
  onShowEvidence,
}: {
  draft: LessonDraft;
  problems: Set<FieldPath>;
  active: boolean;
  selected: boolean;
  onFocus: () => void;
  onShowEvidence: () => void;
}) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const a = draft.activity;
  const question = useField(problems, "activity:question");
  const rationale = useField(problems, "activity:rationale");
  const setActivity = (patch: Partial<LessonActivity>) =>
    ws.updateDraft((d) => markHumanEdit({ ...d, activity: { ...d.activity, ...patch } }));
  const loc = { lang: draft.target_locale, dir: dirOf(draft.target_locale) };
  return (
    <Card
      id="rv-item-section-activity"
      tabIndex={-1}
      className={`rv-editor${selected ? " rv-editor--selected" : ""}${active ? " ring-2 ring-primary" : ""}`}
      data-selected={selected}
      onFocusCapture={onFocus}
      data-testid="activity-editor"
    >
      <h3 className="rv-editor__head mb-2 font-semibold">{t("review.activityTitle")}</h3>
      <label className="block">
        <span className="text-sm font-semibold">{t("review.activityQuestion")}</span>
        <textarea
          className={inputClass}
          rows={2}
          {...loc}
          value={a.question}
          maxLength={500}
          data-testid="activity-question"
          {...question.props}
          onChange={(e) => setActivity({ question: e.target.value })}
        />
      </label>
      <FieldError path="activity:question" problems={problems} />
      <fieldset className="mt-3">
        <legend className="text-sm font-semibold">{t("review.options")}</legend>
        <p className="text-sm text-muted-foreground">{t("review.optionsHelp")}</p>
        {a.options.map((o, i) => {
          const path: FieldPath = `option:${o.id}:text`;
          const field = { "aria-invalid": problems.has(path), "aria-describedby": problems.has(path) ? fieldId(path) : undefined };
          return (
            <div key={o.id} className="mt-2 rounded-md border border-border p-2" data-testid={`option-editor-${o.id}`}>
              <label className="block">
                <span className="text-sm font-semibold">{t("review.optionLabel", { n: i + 1 })}</span>
                <input
                  className={inputClass}
                  {...loc}
                  value={o.text}
                  maxLength={300}
                  data-testid={`option-text-${o.id}`}
                  {...field}
                  onChange={(e) =>
                    setActivity({ options: a.options.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)) })
                  }
                />
              </label>
              <FieldError path={path} problems={problems} />
              <label className="mt-1 flex min-h-10 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="correct-option"
                  className="size-4 accent-primary"
                  checked={a.correct_option_id === o.id}
                  data-testid={`option-correct-${o.id}`}
                  onChange={() => setActivity({ correct_option_id: o.id })}
                />
                <span>{t("review.correctOption", { n: i + 1 })}</span>
              </label>
            </div>
          );
        })}
      </fieldset>
      <label className="mt-3 block">
        <span className="text-sm font-semibold">{t("review.rationale")}</span>
        <textarea
          className={inputClass}
          rows={3}
          {...loc}
          value={a.rationale}
          maxLength={1000}
          data-testid="activity-rationale"
          {...rationale.props}
          onChange={(e) => setActivity({ rationale: e.target.value })}
        />
      </label>
      <FieldError path="activity:rationale" problems={problems} />
      <div className="mt-3 border-t border-dashed border-border pt-2">
        <p className="text-sm font-semibold">{t("evidence.activityTitle")}</p>
        <p className="mb-2 text-sm text-muted-foreground">{t("evidence.activityHelp")}</p>
        <EvidenceQuotes draft={draft} spanIds={a.source_span_ids} testId="activity-evidence" />
        {a.source_span_ids.some((sid) => !draft.spans.some((s) => s.id === sid)) && (
          <p className="bl-relation__missing rv-relation__missing mb-2" data-testid="evidence-unavailable">
            {t("review.evidenceUnavailable")}
          </p>
        )}
        <Button variant="outline" size="sm" id="show-activity-evidence" data-testid="show-activity-evidence" onClick={onShowEvidence}>
          {t("evidence.show")}
        </Button>
      </div>
    </Card>
  );
}

function AckPanel({
  draft,
  label,
  role,
  confirmedFor,
  confirmReset,
  setLabel,
  setRole,
  setConfirmedFor,
}: {
  draft: LessonDraft;
  label: string;
  role: string;
  confirmedFor: string | null;
  confirmReset: boolean;
  setLabel: (v: string) => void;
  setRole: (v: string) => void;
  setConfirmedFor: (v: string | null) => void;
}) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const navigate = useNavigate();
  const key = semanticKey(draft);
  const confirmed = confirmedFor === key;
  const ev = ws.evaluation;
  const failure = ws.validation.state === "failed" ? ws.validation.error : null;
  return (
    <Card className="space-y-3" data-testid="ack-panel">
      <h2 className="text-lg font-semibold">{t("review.ackTitle")}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={ws.displayStatus} />
        {ws.review && ev?.status === "acknowledged_by_user" && (
          <span className="text-sm">{t("review.ackedBy", { label: ws.review.reviewer_label })}</span>
        )}
      </div>
      {ev?.status === "stale" && <p className="text-sm font-semibold text-accent">{t("review.staleHelp")}</p>}
      {failure && (
        <div className="text-sm" role="alert" data-testid="validation-failure">
          <p className="font-semibold">{failure.status === 0 ? t("error.network") : t("review.errors")}</p>
          {failure.status !== 0 && <p>{t("review.structureHelp")}</p>}
          {failure.details.length > 0 && (
            <ul className="list-disc ps-5" dir="ltr" lang="en">
              {failure.details.slice(0, 8).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {ev && ev.errors.length > 0 && (
        <div className="text-sm" data-testid="registry-errors">
          <p className="font-semibold">{t("review.errors")}</p>
          <p>{t("review.registryHelp")}</p>
          <ul className="list-disc ps-5" dir="ltr" lang="en">
            {ev.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs break-all text-muted-foreground">
        {t("review.hash")}: <code dir="ltr">{ev?.lesson_hash ?? "—"}</code>
      </p>
      <label className="block">
        <span className="text-sm font-semibold">{t("review.ackLabel")}</span>
        <input className={inputClass} value={label} maxLength={80} dir="auto" onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="block">
        <span className="text-sm font-semibold">{t("review.ackRole")}</span>
        <input className={inputClass} value={role} maxLength={80} dir="auto" onChange={(e) => setRole(e.target.value)} />
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={confirmed}
          data-testid="ack-confirm"
          onChange={(e) => {
            ws.clearAckSuperseded();
            setConfirmedFor(e.target.checked ? key : null);
          }}
        />
        <span>{t("review.ackConfirm")}</span>
      </label>
      {confirmReset && !confirmed && (
        <p className="text-sm font-semibold text-accent" data-testid="ack-confirm-reset">
          {t("review.confirmReset")}
        </p>
      )}
      <p className="text-sm text-muted-foreground">{t("review.ackHelp")}</p>
      {!ws.canAcknowledge && (
        <p id="ack-requirement" className="text-sm font-semibold">
          {t("review.ackDisabled")}
        </p>
      )}
      <p aria-live="polite" className="text-sm font-semibold" data-testid="ack-progress">
        {ws.acknowledging ? t("review.ackPending") : ws.ackSuperseded ? t("review.ackSuperseded") : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!confirmed || !label.trim() || !ws.canAcknowledge || ws.acknowledging}
          aria-describedby="ack-requirement"
          aria-busy={ws.acknowledging}
          onClick={async () => {
            try {
              const result = await ws.acknowledge(label.trim(), role.trim());
              if (result === "busy") return;
              if (result === "done") ws.setError(null);
              setConfirmedFor(null);
            } catch (e) {
              ws.setError(e instanceof ApiError ? e : new ApiError(String(e), 0));
            }
          }}
        >
          {ws.acknowledging ? t("review.ackPendingButton") : t("review.ackButton")}
        </Button>
        <Button variant="outline" onClick={() => navigate("/preview")}>
          {t("nav.preview")}
        </Button>
      </div>
    </Card>
  );
}

type Highlight = { from: "card" | "activity"; id: string; spanIds: string[] } | null;

export function ReviewPage() {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const navigate = useNavigate();
  const wide = useMediaQuery("(min-width: 1024px)");
  const [highlight, setHighlight] = useState<Highlight>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState("lesson");
  const [reveal, setReveal] = useState<{ n: number; focus: boolean }>({ n: 0, focus: false });
  const [label, setLabel] = useState("");
  const [role, setRole] = useState("");
  const [confirmedFor, setConfirmation] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const originalRef = useRef<HTMLDivElement>(null);
  const draft = ws.draft;
  const key = draft ? semanticKey(draft) : null;

  useEffect(() => {
    if (confirmedFor !== null && confirmedFor !== key) {
      setConfirmation(null);
      setConfirmReset(true);
    }
  }, [confirmedFor, key]);

  const setConfirmedFor = (value: string | null) => {
    setConfirmation(value);
    if (value !== null) setConfirmReset(false);
  };

  useEffect(() => {
    if (reveal.n === 0) return;
    const frame = requestAnimationFrame(() => {
      const mark = originalRef.current?.querySelector<HTMLElement>('mark[data-active="true"]');
      if (!mark) return;
      mark.scrollIntoView({ block: wide ? "nearest" : "center" });
      if (!wide || reveal.focus) mark.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [reveal, wide]);

  if (!draft) {
    return (
      <p>
        {t("preview.empty")} <Link to="/setup" className="text-primary underline">{t("nav.setup")}</Link>
      </p>
    );
  }
  const problems = emptyFields(draft);
  const knownSpans = new Set(draft.spans.map((s) => s.id));
  const activeSpans = (highlight?.spanIds ?? []).filter((id) => knownSpans.has(id));
  const activityHighlighted = highlight?.from === "activity";
  const current = selected ?? (draft.cards[0] ? `card-${draft.cards[0].id}` : "section-activity");

  const outline: OutlineItem[] = [
    { id: "section-title", num: "◆", name: t("review.lessonTitle"), sub: draft.title },
    ...draft.cards.map((c, i) => ({ id: `card-${c.id}`, num: String(i + 1), name: t("review.card", { n: i + 1 }), sub: c.text })),
    ...(draft.terms.length > 0
      ? [{ id: "section-terms", num: String(draft.terms.length), name: t("review.termsTitle"), sub: draft.terms.map((x) => x.display_form).join(" · ") }]
      : []),
    { id: "section-activity", num: "?", name: t("review.activityTitle"), sub: draft.activity.question },
  ];

  const selectItem = (id: string) => {
    setSelected(id);
    const card = draft.cards.find((c) => `card-${c.id}` === id);
    if (card) setHighlight({ from: "card", id: card.id, spanIds: card.source_span_ids });
    if (id === "section-activity") setHighlight({ from: "activity", id: "activity", spanIds: draft.activity.source_span_ids });
    requestAnimationFrame(() => {
      const el = document.getElementById(`rv-item-${id}`);
      if (!el) return;
      el.scrollIntoView({ block: "start" });
      el.focus({ preventScroll: true });
    });
  };

  const jumpToCard = (c: LessonCard) => {
    setSelected(`card-${c.id}`);
    setHighlight({ from: "card", id: c.id, spanIds: c.source_span_ids });
    if (!wide) setTab("original");
    setReveal((r) => ({ n: r.n + 1, focus: true }));
  };

  const showActivityEvidence = () => {
    setSelected("section-activity");
    setHighlight({ from: "activity", id: "activity", spanIds: draft.activity.source_span_ids });
    if (!wide) setTab("original");
    setReveal((r) => ({ n: r.n + 1, focus: false }));
  };

  const original = (
    <section className="bl-source rv-source" aria-labelledby="rv-original-h">
      <h2 id="rv-original-h" className="rv-panel__title">{t("review.original")}</h2>
      <div ref={originalRef}>
        <OriginalText draft={draft} activeSpanIds={activeSpans} />
      </div>
      <p aria-live="polite" className="mt-2 text-sm text-muted-foreground" data-testid="highlight-status">
        {activeSpans.length > 0
          ? t(activityHighlighted ? "evidence.highlightedActivity" : "evidence.highlightedCard", {
              list: activeSpans.join(", "),
            })
          : ""}
      </p>
      {!wide && highlight && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => {
            setTab("lesson");
            const back = activityHighlighted ? "show-activity-evidence" : `rv-item-card-${highlight.id}`;
            requestAnimationFrame(() => document.getElementById(back)?.focus());
          }}
        >
          {t("evidence.back")}
        </Button>
      )}
    </section>
  );
  const lesson = (
    <div className="rv-lesson space-y-3" data-testid="lesson-editor">
      <OriginPanel draft={draft} />
      <Card
        id="rv-item-section-title"
        tabIndex={-1}
        className={`rv-editor${current === "section-title" ? " rv-editor--selected" : ""}`}
        onFocusCapture={() => setSelected("section-title")}
      >
        <label className="block">
          <span className="text-sm font-semibold">{t("review.lessonTitle")}</span>
          <input
            className={inputClass}
            value={draft.title}
            maxLength={200}
            dir="auto"
            aria-invalid={problems.has("title")}
            aria-describedby={problems.has("title") ? fieldId("title") : undefined}
            onChange={(e) => ws.updateDraft((d) => markHumanEdit({ ...d, title: e.target.value }))}
          />
        </label>
        <FieldError path="title" problems={problems} />
      </Card>
      {draft.cards.map((c, i) => (
        <CardEditor
          key={c.id}
          card={c}
          index={i}
          draft={draft}
          problems={problems}
          selected={current === `card-${c.id}`}
          active={highlight?.from === "card" && highlight.id === c.id}
          onFocus={() => {
            setSelected(`card-${c.id}`);
            setHighlight({ from: "card", id: c.id, spanIds: c.source_span_ids });
          }}
          onJump={() => jumpToCard(c)}
        />
      ))}
      {draft.terms.length > 0 && (
        <Card
          id="rv-item-section-terms"
          tabIndex={-1}
          className={`rv-editor${current === "section-terms" ? " rv-editor--selected" : ""}`}
          onFocusCapture={() => setSelected("section-terms")}
          data-testid="terms-editor"
        >
          <h3 className="rv-editor__head mb-1 font-semibold">{t("review.termsTitle")}</h3>
          <p className="mb-3 text-sm text-muted-foreground">{t("review.termsHelp")}</p>
          <div className="space-y-3">
            {draft.terms.map((term) => (
              <TermEditor key={term.term_id} term={term} draft={draft} problems={problems} />
            ))}
          </div>
        </Card>
      )}
      <ActivityEditor
        draft={draft}
        problems={problems}
        selected={current === "section-activity"}
        active={activityHighlighted}
        onFocus={() => {
          setSelected("section-activity");
          setHighlight({ from: "activity", id: "activity", spanIds: draft.activity.source_span_ids });
        }}
        onShowEvidence={showActivityEvidence}
      />
    </div>
  );
  const ack = (
    <AckPanel
      draft={draft}
      label={label}
      role={role}
      confirmedFor={confirmedFor}
      confirmReset={confirmReset}
      setLabel={setLabel}
      setRole={setRole}
      setConfirmedFor={setConfirmedFor}
    />
  );

  return (
    <section className="rv-studio">
      <header className="bl-studio__title rv-title">
        <div className="bl-studio__heading rv-heading">
          <p className="bl-eyebrow">{t("review.title")}</p>
          <h1 className="bl-display rv-display" dir="auto">
            {draft.title}
          </h1>
        </div>
        <div className="bl-studio__primary rv-primary">
          <StatusBadge status={ws.displayStatus} />
          <button type="button" className="bl-btn bl-btn--primary" onClick={() => navigate("/preview")}>
            {t("nav.preview")}
          </button>
        </div>
      </header>
      {wide ? (
        <div className="rv-workspace">
          <ReviewOutline items={outline} selected={current} onSelect={selectItem} />
          <div className="bl-sheet rv-sheet">
            <div className="rv-sheet__inner">{lesson}</div>
          </div>
          <div className="rv-side">
            {original}
            {ack}
          </div>
        </div>
      ) : (
        <Tabs value={tab} onValueChange={setTab} dir={dirOf(document.documentElement.lang || "ar")} className="rv-tabs">
          <TabsList>
            <TabsTrigger value="original">{t("review.original")}</TabsTrigger>
            <TabsTrigger value="lesson">{t("review.lesson")}</TabsTrigger>
            <TabsTrigger value="ack">{t("review.check")}</TabsTrigger>
          </TabsList>
          <TabsContent value="original" forceMount className="data-[state=inactive]:hidden">
            {original}
          </TabsContent>
          <TabsContent value="lesson" forceMount className="data-[state=inactive]:hidden">
            <ReviewOutline items={outline} selected={current} onSelect={selectItem} compact />
            {lesson}
          </TabsContent>
          <TabsContent value="ack" forceMount className="data-[state=inactive]:hidden">
            {ack}
          </TabsContent>
        </Tabs>
      )}
    </section>
  );
}
