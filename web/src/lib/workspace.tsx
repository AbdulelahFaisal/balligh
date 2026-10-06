import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { api, ApiError } from "./api";
import { autosave, browserStorage, loadSaved, recoveryOf, tryReset, type Recovery } from "./storage";
import type { Evaluation, LessonDraft, ReviewRecord, ReviewStatus } from "./types";

type Tagged =
  | { rev: number; kind: "ok"; result: Evaluation }
  | { rev: number; kind: "failed"; error: ApiError };

export type Validation =
  | { state: "none" }
  | { state: "pending" }
  | { state: "ok"; result: Evaluation }
  | { state: "failed"; error: ApiError };

export type DisplayStatus = ReviewStatus | "unverified" | null;

export type ExportKind = "html" | "json";

export type ReplaceKind = "file" | "example";

type Incoming = { draft: LessonDraft; discarded: string[] };

interface Operation {
  id: number;
  rev: number;
  kind: ReplaceKind;
  hadDraft: boolean;
  currentTitle: string;
  after: string;
  incoming: Incoming | null;
}

export type ImportState =
  | { phase: "idle" }
  | { phase: "checking"; kind: ReplaceKind; id: number }
  | { phase: "confirm"; kind: ReplaceKind; id: number; rev: number; title: string; currentTitle: string };

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

interface Workspace {
  draft: LessonDraft | null;
  review: ReviewRecord | null;
  revision: number;
  validation: Validation;
  evaluation: Evaluation | null;
  displayStatus: DisplayStatus;
  canAcknowledge: boolean;
  acknowledging: boolean;
  ackSuperseded: boolean;
  exporting: Record<ExportKind, boolean>;
  importState: ImportState;
  error: ApiError | null;
  notice: string | null;
  saveFailed: boolean;
  recovery: Recovery | null;
  resetFailed: boolean;
  getRevision: () => number;
  updateDraft: (fn: (d: LessonDraft) => LessonDraft) => void;
  replaceWorkspace: (draft: LessonDraft, review: ReviewRecord | null) => void;
  acknowledge: (label: string, role: string) => Promise<"done" | "superseded" | "busy">;
  clearAckSuperseded: () => void;
  exportLesson: (kind: ExportKind) => Promise<void>;
  importFile: (file: File) => void;
  openExample: (id: string, after: string) => void;
  confirmImport: () => void;
  cancelImport: () => void;
  setError: (e: ApiError | null) => void;
  setNotice: (n: string | null) => void;
  clear: () => void;
  resetStoredData: () => void;
}

const Ctx = createContext<Workspace | null>(null);

const asApiError = (e: unknown, status = 0) => (e instanceof ApiError ? e : new ApiError(String(e), status));

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const initial = useMemo(() => loadSaved(browserStorage()), []);
  const start = initial.kind === "ok" ? initial.saved : { draft: null, review: null };

  const [draft, setDraft] = useState<LessonDraft | null>(start.draft);
  const [review, setReview] = useState<ReviewRecord | null>(start.review);
  const [rev, setRev] = useState(0);
  const revRef = useRef(0);
  const [tagged, setTagged] = useState<Tagged | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [recovery, setRecovery] = useState<Recovery | null>(recoveryOf(initial));
  const [resetFailed, setResetFailed] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [ackSuperseded, setAckSuperseded] = useState(false);
  const ackBusy = useRef(false);
  const [exporting, setExporting] = useState<Record<ExportKind, boolean>>({ html: false, json: false });
  const exportBusy = useRef<Record<ExportKind, boolean>>({ html: false, json: false });
  const [importState, setImportState] = useState<ImportState>({ phase: "idle" });
  const operation = useRef<Operation | null>(null);
  const operationSeq = useRef(0);

  const bump = useCallback(() => {
    revRef.current += 1;
    setRev(revRef.current);
  }, []);
  const getRevision = useCallback(() => revRef.current, []);

  useEffect(() => {
    const outcome = autosave(browserStorage(), { version: 1, draft, review }, recovery !== null);
    if (outcome !== "paused") setSaveFailed(outcome === "failed");
  }, [draft, review, recovery]);

  useEffect(() => {
    if (!draft) return;
    const mine = rev;
    const timer = setTimeout(() => {
      api
        .validate(draft, review)
        .then((result) => {
          if (revRef.current === mine) setTagged({ rev: mine, kind: "ok", result });
        })
        .catch((e: unknown) => {
          if (revRef.current === mine) setTagged({ rev: mine, kind: "failed", error: asApiError(e) });
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, review, rev]);

  useEffect(() => {
    const op = operation.current;
    if (op && op.rev !== rev) {
      operation.current = null;
      setImportState({ phase: "idle" });
      setNotice(t(op.kind === "file" ? "import.superseded" : "example.superseded"));
    }
  }, [rev, t]);

  const current = tagged && tagged.rev === rev ? tagged : null;
  const validation: Validation = !draft
    ? { state: "none" }
    : !current
      ? { state: "pending" }
      : current.kind === "ok"
        ? { state: "ok", result: current.result }
        : { state: "failed", error: current.error };
  const evaluation = validation.state === "ok" ? validation.result : null;
  const displayStatus: DisplayStatus =
    validation.state === "ok" ? validation.result.status : validation.state === "failed" ? "unverified" : null;
  const canAcknowledge = validation.state === "ok" && validation.result.valid;

  const updateDraft = useCallback(
    (fn: (d: LessonDraft) => LessonDraft) => {
      setDraft((d) => (d ? fn(d) : d));
      bump();
    },
    [bump],
  );

  const replaceWorkspace = useCallback(
    (d: LessonDraft, r: ReviewRecord | null) => {
      setDraft(d);
      setReview(r);
      setAckSuperseded(false);
      bump();
    },
    [bump],
  );

  const acknowledge = useCallback(
    async (label: string, role: string) => {
      if (!draft) return "superseded" as const;
      if (ackBusy.current) return "busy" as const;
      ackBusy.current = true;
      setAcknowledging(true);
      setAckSuperseded(false);
      const mine = revRef.current;
      try {
        const res = await api.acknowledge(draft, label, role);
        if (revRef.current !== mine) {
          setAckSuperseded(true);
          return "superseded" as const;
        }
        setReview(res.review);
        bump();
        return "done" as const;
      } finally {
        ackBusy.current = false;
        setAcknowledging(false);
      }
    },
    [draft, bump],
  );

  const exportLesson = useCallback(
    async (kind: ExportKind) => {
      if (!draft || exportBusy.current[kind]) return;
      exportBusy.current[kind] = true;
      setExporting((s) => ({ ...s, [kind]: true }));
      const mine = revRef.current;
      const file = `balligh-lesson.${kind}`;
      try {
        const blob = await api.exportFile(kind, draft, review);
        if (revRef.current !== mine) {
          setNotice(t("export.changed", { file }));
          return;
        }
        downloadBlob(blob, file);
        setNotice(t("export.requested", { file }));
      } catch (e) {
        setError(asApiError(e));
      } finally {
        exportBusy.current[kind] = false;
        setExporting((s) => ({ ...s, [kind]: false }));
      }
    },
    [draft, review, t],
  );

  const begin = (kind: ReplaceKind, after: string): Operation | null => {
    if (operation.current) return null;
    const op: Operation = {
      id: ++operationSeq.current,
      rev: revRef.current,
      kind,
      hadDraft: draft !== null,
      currentTitle: draft?.title ?? "",
      after,
      incoming: null,
    };
    operation.current = op;
    setNotice(null);
    setImportState({ phase: "checking", kind, id: op.id });
    return op;
  };

  const isLive = (op: Operation) => operation.current?.id === op.id && revRef.current === op.rev;

  const fail = (op: Operation, e: ApiError) => {
    if (!isLive(op)) return;
    operation.current = null;
    setImportState({ phase: "idle" });
    setError(e);
  };

  const commit = (op: Operation, incoming: Incoming) => {
    operation.current = null;
    setImportState({ phase: "idle" });
    setDraft(incoming.draft);
    setReview(null);
    setAckSuperseded(false);
    bump();
    setError(null);
    if (op.kind === "file") {
      const discarded = incoming.discarded.length
        ? " " + t("import.discarded", { list: incoming.discarded.join(", ") })
        : "";
      setNotice(t("import.done") + discarded);
    } else {
      setNotice(null);
    }
    navigate(op.after);
  };

  const settle = (op: Operation, incoming: Incoming) => {
    if (!isLive(op)) return;
    if (!op.hadDraft) {
      commit(op, incoming);
      return;
    }
    op.incoming = incoming;
    setImportState({
      phase: "confirm",
      kind: op.kind,
      id: op.id,
      rev: op.rev,
      title: incoming.draft.title,
      currentTitle: op.currentTitle,
    });
  };

  const importFile = (file: File) => {
    if (operation.current) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setNotice(null);
      setError(new ApiError(t("import.tooBig"), 413));
      return;
    }
    const op = begin("file", "/review");
    if (!op) return;
    file.text().then(
      (text) => {
        if (!isLive(op)) return;
        api.importFile(text).then(
          (res) => settle(op, { draft: res.draft, discarded: res.discarded_claims }),
          (e: unknown) => fail(op, asApiError(e, 400)),
        );
      },
      () => fail(op, new ApiError(t("import.unreadable"), 400)),
    );
  };

  const openExample = (id: string, after: string) => {
    const op = begin("example", after);
    if (!op) return;
    api.example(id).then(
      (res) => settle(op, { draft: res.draft, discarded: [] }),
      (e: unknown) => fail(op, asApiError(e)),
    );
  };

  const confirmImport = () => {
    const op = operation.current;
    if (!op || !op.incoming || importState.phase !== "confirm" || importState.id !== op.id) return;
    if (revRef.current !== op.rev) {
      operation.current = null;
      setImportState({ phase: "idle" });
      setNotice(t(op.kind === "file" ? "import.superseded" : "example.superseded"));
      return;
    }
    commit(op, op.incoming);
  };

  const cancelImport = () => {
    const op = operation.current;
    operation.current = null;
    setImportState({ phase: "idle" });
    setNotice(t(op?.kind === "example" ? "example.kept" : "import.kept"));
  };

  const clear = useCallback(() => {
    setDraft(null);
    setReview(null);
    setAckSuperseded(false);
    setNotice(null);
    bump();
  }, [bump]);

  const resetStoredData = useCallback(() => {
    if (tryReset(browserStorage())) {
      setResetFailed(false);
      setRecovery(null);
    } else {
      setResetFailed(true);
    }
  }, []);

  const value: Workspace = {
    draft,
    review,
    revision: rev,
    validation,
    evaluation,
    displayStatus,
    canAcknowledge,
    acknowledging,
    ackSuperseded,
    exporting,
    importState,
    error,
    notice,
    saveFailed,
    recovery,
    resetFailed,
    getRevision,
    updateDraft,
    replaceWorkspace,
    acknowledge,
    clearAckSuperseded: () => setAckSuperseded(false),
    exportLesson,
    importFile,
    openExample,
    confirmImport,
    cancelImport,
    setError,
    setNotice,
    clear,
    resetStoredData,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): Workspace {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace outside provider");
  return v;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 60_000);
}
