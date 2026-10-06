import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, isAbort } from "./api";
import { canApplyResult, type GenerationTicket } from "./provenance";
import type { LessonDraft, Level, Locale, TeacherSource } from "./types";
import { useWorkspace } from "./workspace";

export interface GenerationOptions {
  sourceId: string;
  sourceVersion: string;
  sourceSha256: string;
  locale: Locale;
  level: Level;
  teacherSource?: TeacherSource;
}

export type GenerationState =
  | { phase: "idle" }
  | { phase: "confirm"; options: GenerationOptions }
  | { phase: "running"; options: GenerationOptions; startedAt: number }
  | { phase: "cancelled" }
  | { phase: "discarded" }
  | { phase: "failed"; options: GenerationOptions; error: ApiError };

export const optionKey = (o: GenerationOptions | null): string | null =>
  o && JSON.stringify([o.sourceId, o.sourceVersion, o.sourceSha256, o.locale, o.level]);

export function forCurrentOptions(state: GenerationState, current: string | null): GenerationState {
  if ((state.phase === "confirm" || state.phase === "failed") && optionKey(state.options) !== current)
    return { phase: "idle" };
  return state;
}

export function useGeneration(onReady: (draft: LessonDraft) => void) {
  const { getRevision, replaceWorkspace } = useWorkspace();
  const [state, setState] = useState<GenerationState>({ phase: "idle" });
  const opRef = useRef(0);
  const busy = useRef(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      opRef.current += 1;
      controller.current?.abort();
    },
    [],
  );

  const run = useCallback(
    async (options: GenerationOptions) => {
      if (busy.current) return;
      busy.current = true;
      const ticket: GenerationTicket = { opId: ++opRef.current, revision: getRevision() };
      const abort = new AbortController();
      controller.current = abort;
      setState({ phase: "running", options, startedAt: Date.now() });
      try {
        const res = await api.generate(
          {
            request_id: crypto.randomUUID(),
            source_id: options.sourceId,
            source_version: options.sourceVersion,
            source_sha256: options.sourceSha256,
            target_locale: options.locale,
            level: options.level,
            ...(options.teacherSource ? { teacher_source: options.teacherSource } : {}),
          },
          abort.signal,
        );
        if (ticket.opId !== opRef.current) return;
        if (!canApplyResult(ticket, opRef.current, getRevision(), abort.signal.aborted)) {
          setState(abort.signal.aborted ? { phase: "cancelled" } : { phase: "discarded" });
          return;
        }
        replaceWorkspace(res.draft, null);
        setState({ phase: "idle" });
        onReady(res.draft);
      } catch (e) {
        if (ticket.opId !== opRef.current) return;
        if (abort.signal.aborted || isAbort(e)) setState({ phase: "cancelled" });
        else setState({ phase: "failed", options, error: e instanceof ApiError ? e : new ApiError(String(e), 0) });
      } finally {
        if (ticket.opId === opRef.current) {
          busy.current = false;
          controller.current = null;
        }
      }
    },
    [getRevision, replaceWorkspace, onReady],
  );

  const start = useCallback(
    (options: GenerationOptions, replacesDraft: boolean) => {
      if (busy.current) return;
      if (replacesDraft) setState({ phase: "confirm", options });
      else void run(options);
    },
    [run],
  );

  const cancel = useCallback(() => controller.current?.abort(), []);
  const dismiss = useCallback(() => {
    if (!busy.current) setState({ phase: "idle" });
  }, []);
  const syncOptions = useCallback((current: string | null) => {
    setState((s) => forCurrentOptions(s, current));
  }, []);

  return { state, start, run, cancel, dismiss, syncOptions };
}
