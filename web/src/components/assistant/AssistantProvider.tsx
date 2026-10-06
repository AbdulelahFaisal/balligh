import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { cleanQuestion, type SourceScope } from "@/lib/assistant";
import { useAssistantSession, type AssistantSession, type ScopeChoice } from "./useAssistantSession";
import { AssistantPanel } from "./AssistantPanel";

type Published = { token: number; scope: SourceScope } | null;

interface ScopeApi {
  publish: (scope: SourceScope) => number;
  clear: (token: number) => void;
}

interface AssistantApi {
  open: boolean;
  setOpen: (open: boolean) => void;
  launcherRef: RefObject<HTMLButtonElement | null>;
  session: AssistantSession;
  openWith: (request: { scope: ScopeChoice; question: string }) => void;
}

const ScopeContext = createContext<ScopeApi | null>(null);
const AssistantContext = createContext<AssistantApi | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [published, setPublished] = useState<Published>(null);
  const [open, setOpenState] = useState(false);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const counter = useRef(0);
  const session = useAssistantSession(published?.scope ?? null, open);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const scopeApi = useMemo<ScopeApi>(
    () => ({
      publish: (scope) => {
        counter.current += 1;
        const token = counter.current;
        setPublished({ token, scope });
        return token;
      },
      clear: (token) => setPublished((cur) => (cur?.token === token ? null : cur)),
    }),
    [],
  );

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    if (!next) requestAnimationFrame(() => launcherRef.current?.focus());
  }, []);

  const openWith = useCallback(({ scope, question }: { scope: ScopeChoice; question: string }) => {
    const current = sessionRef.current;
    current.setChoice(scope);
    if (cleanQuestion(current.question) === null) current.setQuestion(question);
    setOpenState(true);
  }, []);

  return (
    <ScopeContext.Provider value={scopeApi}>
      <AssistantContext.Provider value={{ open, setOpen, launcherRef, session, openWith }}>
        {children}
        {open && <AssistantPanel session={session} onClose={() => setOpen(false)} />}
      </AssistantContext.Provider>
    </ScopeContext.Provider>
  );
}

export function useAssistant(): AssistantApi | null {
  return useContext(AssistantContext);
}

export function useAssistantScope(scope: SourceScope | null) {
  const api = useContext(ScopeContext);
  const key = scope ? JSON.stringify(scope) : null;
  const latest = useRef(scope);
  latest.current = scope;
  useEffect(() => {
    if (!api || !key || !latest.current) return;
    const token = api.publish(latest.current);
    return () => api.clear(token);
  }, [api, key]);
}
