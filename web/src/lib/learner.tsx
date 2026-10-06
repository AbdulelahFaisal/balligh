import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { freshProgress, loadProgress, removeProgress, saveProgress, type Progress, type ProgressMode } from "./progress";
import { semanticKey } from "./semantic";
import { browserStorage } from "./storage";
import { useWorkspace } from "./workspace";

interface Learner {
  lessonKey: string | null;
  progress: Progress | null;
  mode: ProgressMode;
  resetFailed: boolean;
  markRead: (read: boolean) => void;
  openTerm: (termId: string) => void;
  choose: (optionId: string) => void;
  check: (correctOptionId: string) => void;
  retry: () => void;
  reset: () => void;
}

const Ctx = createContext<Learner | null>(null);

export function LearnerProvider({ children }: { children: ReactNode }) {
  const { draft } = useWorkspace();
  const lessonKey = useMemo(() => (draft ? semanticKey(draft) : null), [draft]);
  const initial = useMemo(() => loadProgress(browserStorage()), []);
  const [mode, setMode] = useState<ProgressMode>(
    initial.kind === "unavailable" ? "unavailable" : initial.kind === "corrupt" ? "corrupt" : "saved",
  );
  const [stored, setStored] = useState<Progress | null>(initial.kind === "ok" ? initial.progress : null);
  const [resetFailed, setResetFailed] = useState(false);
  const previousKey = useRef(lessonKey);

  useEffect(() => {
    if (previousKey.current === lessonKey) return;
    previousKey.current = lessonKey;
    setStored(lessonKey ? freshProgress(lessonKey) : null);
  }, [lessonKey]);

  useEffect(() => {
    if (mode === "corrupt" || mode === "unavailable") return;
    const storage = browserStorage();
    const ok = stored ? saveProgress(storage, stored) : removeProgress(storage);
    setMode(ok ? "saved" : "write_failed");
  }, [stored, mode]);

  const progress = lessonKey === null ? null : stored?.lesson === lessonKey ? stored : freshProgress(lessonKey);

  const update = useCallback(
    (fn: (p: Progress) => Progress) => {
      if (!lessonKey) return;
      setStored((s) => fn(s?.lesson === lessonKey ? s : freshProgress(lessonKey)));
    },
    [lessonKey],
  );

  const reset = useCallback(() => {
    const removed = removeProgress(browserStorage());
    setResetFailed(!removed);
    if (removed) setMode((m) => (m === "corrupt" || m === "unavailable" ? "saved" : m));
    setStored(lessonKey ? freshProgress(lessonKey) : null);
  }, [lessonKey]);

  const value: Learner = {
    lessonKey,
    progress,
    mode,
    resetFailed,
    markRead: (read) => update((p) => ({ ...p, read })),
    openTerm: (termId) =>
      update((p) => (p.terms.includes(termId) ? p : { ...p, terms: [...p.terms, termId].slice(-12) })),
    choose: (optionId) => update((p) => ({ ...p, choice: optionId, checked: null })),
    check: (correctOptionId) =>
      update((p) =>
        p.choice ? { ...p, checked: p.choice, solved: p.solved || p.choice === correctOptionId } : p,
      ),
    retry: () => update((p) => ({ ...p, choice: null, checked: null })),
    reset,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLearner(): Learner {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLearner outside provider");
  return v;
}
