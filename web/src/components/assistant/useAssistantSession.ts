import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";
import {
  askAssistant,
  AssistantError,
  buildAskBody,
  cleanQuestion,
  HISTORY_LIMIT,
  replyApplies,
  resolveScope,
  scopeKey,
  stillApplies,
  TEACHER_PATHS,
  ticketFor,
  type AskReply,
  type AskScope,
  type SourceScope,
  type Ticket,
} from "@/lib/assistant";

export type ScopeChoice = "site" | "source";

export type Entry = {
  ticket: Ticket;
  question: string;
  scope: SourceScope | null;
  context: AskScope["context"];
} & (
  | { state: "sending" }
  | { state: "answered"; reply: AskReply }
  | { state: "error"; error: AssistantError }
  | { state: "cancelled"; reason: "user" | "context" }
);

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

export function useAssistantSession(published: SourceScope | null, open: boolean) {
  const { i18n } = useTranslation();
  const location = useLocation();
  const teacherPage = TEACHER_PATHS.includes(location.pathname);
  const source = teacherPage ? null : published;
  const [choice, setChoice] = useState<ScopeChoice>("source");
  const [picked, setPicked] = useState(1);
  const [question, setQuestion] = useState("");
  const [emptyTried, setEmptyTried] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const ctrl = useRef<AbortController | null>(null);
  const ticket = useRef<Ticket | null>(null);
  const revision = useRef(0);

  const active = choice === "source" && source !== null ? source : null;
  const ask = resolveScope(active, picked);
  const locale = active ? active.locale : i18n.language;
  const key = ask ? scopeKey(ask, locale) : null;
  const live = useRef({ key, locale });
  live.current = { key, locale };
  const routeSurah = source?.mode === "quran" ? source.route.surah : null;

  const patch = useCallback((t: Ticket, next: Entry) => {
    setEntries((list) => list.map((e) => (e.ticket.requestId === t.requestId ? next : e)));
  }, []);

  const stop = useCallback((reason: "user" | "context") => {
    const c = ctrl.current;
    const t = ticket.current;
    ctrl.current = null;
    ticket.current = null;
    if (!c || !t) return;
    c.abort();
    setEntries((list) =>
      list.map((e) => (e.ticket.requestId === t.requestId && e.state === "sending" ? { ...e, state: "cancelled", reason } : e)),
    );
  }, []);

  useEffect(() => () => stop("context"), [key, locale, location.pathname, location.search, stop]);
  useEffect(() => {
    if (!open) stop("context");
  }, [open, stop]);
  useEffect(() => setPicked(1), [routeSurah]);

  const send = useCallback(
    (text: string, sentRevision: number | null) => {
      if (ctrl.current) return;
      const q = cleanQuestion(text);
      if (q === null) {
        setEmptyTried(true);
        return;
      }
      if (!ask) return;
      setEmptyTried(false);
      const body = buildAskBody(ask, locale, q);
      const t = ticketFor(body, ask);
      const c = new AbortController();
      ctrl.current = c;
      ticket.current = t;
      const base = { ticket: t, question: q, scope: active, context: ask.context };
      setEntries((list) => [{ ...base, state: "sending" } as Entry, ...list].slice(0, HISTORY_LIMIT + 1));
      askAssistant(body, c.signal).then(
        (reply) => {
          if (!replyApplies(reply, t, ticket.current, live.current.key, live.current.locale)) return;
          ctrl.current = null;
          ticket.current = null;
          patch(t, { ...base, state: "answered", reply });
          if (sentRevision !== null && revision.current === sentRevision) setQuestion("");
        },
        (err: unknown) => {
          if (isAbort(err) || !stillApplies(t, ticket.current, live.current.key, live.current.locale)) return;
          ctrl.current = null;
          ticket.current = null;
          const error = err instanceof AssistantError ? err : new AssistantError(String(err), 0, "network", true);
          patch(t, { ...base, state: "error", error });
        },
      );
    },
    [ask, locale, active, patch],
  );

  const sending = entries[0]?.state === "sending";

  return {
    teacherPage,
    source,
    choice: active ? "source" : ("site" as ScopeChoice),
    setChoice,
    picked,
    setPicked,
    question,
    setQuestion: (v: string) => {
      revision.current += 1;
      setQuestion(v);
      if (v.trim()) setEmptyTried(false);
    },
    emptyTried,
    entries,
    sending,
    canSend: !sending && ask !== null && cleanQuestion(question) !== null,
    ready: ask !== null,
    locale,
    send: () => send(question, revision.current),
    canRetry: (entry: Entry) =>
      entry.state === "error" && key !== null && entry.ticket.scopeKey === key && entry.ticket.locale === locale,
    retry: (entry: Entry) => {
      if (ctrl.current || entry.state !== "error") return;
      if (entry.ticket.scopeKey !== live.current.key || entry.ticket.locale !== live.current.locale) return;
      send(entry.question, null);
    },
    cancel: () => stop("user"),
  };
}

export type AssistantSession = ReturnType<typeof useAssistantSession>;
