import type { StorageLike } from "./storage";

export const PROGRESS_KEY = "balligh.progress.v1";
const MAX_TERMS = 12;

export interface Progress {
  version: 1;
  lesson: string;
  read: boolean;
  terms: string[];
  choice: string | null;
  checked: string | null;
  solved: boolean;
}

export type ProgressLoad =
  | { kind: "empty" }
  | { kind: "ok"; progress: Progress }
  | { kind: "corrupt" }
  | { kind: "unavailable" };

export type ProgressMode = "saved" | "unavailable" | "corrupt" | "write_failed";

export const freshProgress = (lesson: string): Progress => ({
  version: 1,
  lesson,
  read: false,
  terms: [],
  choice: null,
  checked: null,
  solved: false,
});

const isStr = (v: unknown): v is string => typeof v === "string";
const isNullableStr = (v: unknown) => v === null || isStr(v);

export function parseProgress(raw: string | null): ProgressLoad {
  if (raw === null || raw === "") return { kind: "empty" };
  let p: unknown;
  try {
    p = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }
  if (typeof p !== "object" || p === null || Array.isArray(p)) return { kind: "corrupt" };
  const o = p as Record<string, unknown>;
  const valid =
    o.version === 1 &&
    isStr(o.lesson) &&
    typeof o.read === "boolean" &&
    Array.isArray(o.terms) &&
    o.terms.length <= MAX_TERMS &&
    o.terms.every(isStr) &&
    isNullableStr(o.choice) &&
    isNullableStr(o.checked) &&
    typeof o.solved === "boolean";
  if (!valid) return { kind: "corrupt" };
  return {
    kind: "ok",
    progress: {
      version: 1,
      lesson: o.lesson as string,
      read: o.read as boolean,
      terms: o.terms as string[],
      choice: o.choice as string | null,
      checked: o.checked as string | null,
      solved: o.solved as boolean,
    },
  };
}

export function loadProgress(storage: StorageLike | null): ProgressLoad {
  if (!storage) return { kind: "unavailable" };
  try {
    return parseProgress(storage.getItem(PROGRESS_KEY));
  } catch {
    return { kind: "unavailable" };
  }
}

export function saveProgress(storage: StorageLike | null, progress: Progress): boolean {
  if (!storage) return false;
  try {
    storage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    return true;
  } catch {
    return false;
  }
}

export function removeProgress(storage: StorageLike | null): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(PROGRESS_KEY);
    return true;
  } catch {
    return false;
  }
}
