import { useCallback, useEffect, useState } from "react";
import { browserStorage } from "./storage";

export const COMPLETION_KEY = "balligh.learn-completion.v1";
export const COMPLETION_SCHEMA = "balligh.learn-completion/1";
export const STAGES_SCHEMA = "balligh.learn.stages.v1";

export type StageCollection = "quran" | "fatwa" | "hadith";

export interface StageEntry {
  collection: StageCollection;
  source_id: string;
  recap: boolean;
  title: string;
  languages: string[];
  /** Fatwas only: locales that have an AI-assisted translation (never part of `languages`). */
  machine_languages?: string[];
  /** Fatwas only: AI-assisted titles by locale. */
  translated_titles?: Record<string, string>;
  content_sha256: string;
  href: string;
}

export interface Stage {
  order: number;
  key: string;
  entries: StageEntry[];
}

export interface HumanSupport {
  name: string;
  operator_ar: string;
  url: string;
  faq_url: string;
}

export interface StagePath {
  schema: string;
  version: string;
  path_id: string;
  identity: string;
  entry_count: number;
  distinct_count: number;
  stages: Stage[];
  not_covered: string[];
  human_support: HumanSupport;
}

export interface CompletionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type CompletionNotice = "malformed" | "unavailable" | "write_failed" | "outdated" | null;

export type CompletionLoad =
  | { kind: "empty" }
  | { kind: "ok"; done: string[] }
  | { kind: "outdated" }
  | { kind: "malformed" }
  | { kind: "unavailable" };

export type CompletionSave = "saved" | "malformed" | "unavailable" | "write_failed";

const HEX = /^[0-9a-f]{64}$/;
const ENTRY_KEY = /^(quran|fatwa|hadith)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[0-9a-f]{64}$/;

export const entryKey = (e: Pick<StageEntry, "collection" | "source_id" | "content_sha256">) =>
  `${e.collection}/${e.source_id}:${e.content_sha256}`;

export function distinctKeys(path: StagePath): string[] {
  return [...new Set(path.stages.flatMap((s) => s.entries.map(entryKey)))];
}

function isEntry(x: unknown): x is StageEntry {
  if (!x || typeof x !== "object") return false;
  const e = x as StageEntry;
  return (
    (e.collection === "quran" || e.collection === "fatwa" || e.collection === "hadith") &&
    typeof e.source_id === "string" &&
    typeof e.recap === "boolean" &&
    typeof e.title === "string" &&
    e.title.length > 0 &&
    Array.isArray(e.languages) &&
    e.languages.every((l) => typeof l === "string") &&
    typeof e.content_sha256 === "string" &&
    HEX.test(e.content_sha256) &&
    typeof e.href === "string" &&
    e.href.startsWith("/library/")
  );
}

export function isStagePath(x: unknown): x is StagePath {
  if (!x || typeof x !== "object") return false;
  const p = x as StagePath;
  return (
    p.schema === STAGES_SCHEMA &&
    typeof p.version === "string" &&
    typeof p.identity === "string" &&
    HEX.test(p.identity) &&
    Array.isArray(p.stages) &&
    p.stages.length > 0 &&
    p.stages.every((s) => s && typeof s.order === "number" && typeof s.key === "string" && Array.isArray(s.entries) && s.entries.every(isEntry)) &&
    Array.isArray(p.not_covered) &&
    !!p.human_support &&
    p.human_support.url === "https://edialogue.org/" &&
    p.human_support.faq_url === "https://edialogue.org/faq/"
  );
}

export function parseCompletion(raw: string | null, path: Pick<StagePath, "version" | "identity">, valid: Set<string>): CompletionLoad {
  if (raw === null) return { kind: "empty" };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: "malformed" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { kind: "malformed" };
  const d = data as Record<string, unknown>;
  if (d.schema !== COMPLETION_SCHEMA || typeof d.version !== "string" || typeof d.identity !== "string") return { kind: "malformed" };
  if (!Array.isArray(d.done) || !d.done.every((k) => typeof k === "string" && ENTRY_KEY.test(k))) return { kind: "malformed" };
  if (d.version !== path.version || d.identity !== path.identity) return { kind: "outdated" };
  return { kind: "ok", done: (d.done as string[]).filter((k) => valid.has(k)) };
}

export function loadCompletion(storage: CompletionStore | null, path: StagePath): CompletionLoad {
  if (!storage) return { kind: "unavailable" };
  try {
    return parseCompletion(storage.getItem(COMPLETION_KEY), path, new Set(distinctKeys(path)));
  } catch {
    return { kind: "unavailable" };
  }
}

export function saveCompletion(storage: CompletionStore | null, path: StagePath, done: string[], replaceOutdated = false): CompletionSave {
  if (!storage) return "unavailable";
  let current: CompletionLoad;
  try {
    current = parseCompletion(storage.getItem(COMPLETION_KEY), path, new Set(distinctKeys(path)));
  } catch {
    return "unavailable";
  }
  if (current.kind === "malformed") return "malformed";
  if (current.kind === "outdated" && !replaceOutdated) return "malformed";
  const valid = new Set(distinctKeys(path));
  const record = {
    schema: COMPLETION_SCHEMA,
    version: path.version,
    identity: path.identity,
    done: [...new Set(done)].filter((k) => valid.has(k)),
    saved_at: new Date().toISOString(),
  };
  try {
    storage.setItem(COMPLETION_KEY, JSON.stringify(record));
  } catch {
    return "write_failed";
  }
  return "saved";
}

type PathState = { status: "loading" } | { status: "ready"; data: StagePath } | { status: "error" };

let cache: Promise<StagePath> | null = null;

export function loadStagePath(): Promise<StagePath> {
  cache ??= fetch("/api/learn/stages", { headers: { Accept: "application/json" } })
    .then(async (res) => {
      if (!res.ok) throw new Error(String(res.status));
      const data: unknown = await res.json();
      if (!isStagePath(data)) throw new Error("invalid");
      return { ...data, stages: [...data.stages].sort((a, b) => a.order - b.order) };
    })
    .catch((e: unknown) => {
      cache = null;
      throw e;
    });
  return cache;
}

export function useStagePath(): { state: PathState; retry: () => void } {
  const [state, setState] = useState<PathState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    loadStagePath().then(
      (data) => live && setState({ status: "ready", data }),
      () => live && setState({ status: "error" }),
    );
    return () => {
      live = false;
    };
  }, [nonce]);
  return { state, retry: () => setNonce((n) => n + 1) };
}

export function useCompletion(path: StagePath | null): {
  done: Set<string>;
  notice: CompletionNotice;
  mark: (key: string, read: boolean) => void;
} {
  const [done, setDone] = useState<string[]>([]);
  const [notice, setNotice] = useState<CompletionNotice>(null);
  const [outdated, setOutdated] = useState(false);
  useEffect(() => {
    if (!path) return;
    const loaded = loadCompletion(browserStorage(), path);
    setDone(loaded.kind === "ok" ? loaded.done : []);
    setOutdated(loaded.kind === "outdated");
    setNotice(loaded.kind === "ok" || loaded.kind === "empty" ? null : loaded.kind);
  }, [path]);
  const mark = useCallback(
    (key: string, read: boolean) => {
      if (!path) return;
      setDone((prev) => {
        const next = read ? [...new Set([...prev, key])] : prev.filter((k) => k !== key);
        const outcome = saveCompletion(browserStorage(), path, next, outdated);
        if (outcome === "saved") {
          setOutdated(false);
          setNotice(null);
        } else setNotice(outcome);
        return next;
      });
    },
    [path, outdated],
  );
  return { done: new Set(done), notice, mark };
}

export const PATH_ID = "introductory-reading";

export interface StagePosition {
  stage: Stage;
  index: number;
  entry: StageEntry;
}

const POSITIVE = /^[1-9][0-9]{0,2}$/;

const hrefPath = (href: string) => {
  const bare = href.split("#")[0].split("?")[0];
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
};

/** Reader link that carries the stage context (1-based stage order and entry position). */
export function contextHref(entry: StageEntry, stage: number, position: number, lang?: string | null): string {
  const [base, query = ""] = entry.href.split("#")[0].split("?");
  const p = new URLSearchParams(query);
  if (lang) p.set("lang", lang);
  p.set("path", PATH_ID);
  p.set("stage", String(stage));
  p.set("entry", String(position));
  return `${base}?${p.toString()}`;
}

/** Valid context only: right path id, integer stage/entry in range, and the entry must be the page being read. */
export function parseStageContext(path: StagePath, params: URLSearchParams, pathname: string): StagePosition | null {
  if (params.get("path") !== PATH_ID) return null;
  const rawStage = params.get("stage") ?? "";
  const rawEntry = params.get("entry") ?? "";
  if (!POSITIVE.test(rawStage) || !POSITIVE.test(rawEntry)) return null;
  const stage = path.stages.find((s) => s.order === Number(rawStage));
  if (!stage) return null;
  const index = Number(rawEntry) - 1;
  const entry = stage.entries[index];
  if (!entry) return null;
  let current = pathname;
  try {
    current = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  return hrefPath(entry.href) === current ? { stage, index, entry } : null;
}

/** The following entry in path order: the rest of this stage, then the next stage's first entry; null at the end. */
export function nextPosition(path: StagePath, at: Pick<StagePosition, "stage" | "index">): StagePosition | null {
  const within = at.stage.entries[at.index + 1];
  if (within) return { stage: at.stage, index: at.index + 1, entry: within };
  const later = path.stages.find((s) => s.order > at.stage.order && s.entries.length > 0);
  return later ? { stage: later, index: 0, entry: later.entries[0] } : null;
}

/** First entry, in stage order, that has not been explicitly marked as read. */
export function firstUnread(path: StagePath, done: Set<string>): StagePosition | null {
  for (const stage of path.stages)
    for (let index = 0; index < stage.entries.length; index++)
      if (!done.has(entryKey(stage.entries[index]))) return { stage, index, entry: stage.entries[index] };
  return null;
}
