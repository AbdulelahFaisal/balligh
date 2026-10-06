import { describe, expect, it } from "vitest";
import { freshProgress, loadProgress, parseProgress, PROGRESS_KEY, removeProgress, saveProgress } from "./progress";
import { STORAGE_KEY, type StorageLike } from "./storage";

function memory(initial: Record<string, string> = {}, opts: { failRead?: boolean; failWrite?: boolean; failRemove?: boolean } = {}) {
  const data = new Map(Object.entries(initial));
  const s: StorageLike & { data: Map<string, string> } = {
    data,
    getItem: (k) => {
      if (opts.failRead) throw new DOMException("blocked", "SecurityError");
      return data.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (opts.failWrite) throw new DOMException("quota", "QuotaExceededError");
      data.set(k, v);
    },
    removeItem: (k) => {
      if (opts.failRemove) throw new DOMException("blocked", "SecurityError");
      data.delete(k);
    },
  };
  return s;
}

describe("progress storage", () => {
  it("round-trips a record under its own key and leaves the workspace key alone", () => {
    const s = memory({ [STORAGE_KEY]: "WORKSPACE-BYTES" });
    const p = { ...freshProgress("lesson:abc"), read: true, terms: ["t1"], choice: "b", checked: "b", solved: true };
    expect(saveProgress(s, p)).toBe(true);
    expect(loadProgress(s)).toEqual({ kind: "ok", progress: p });
    expect(s.data.get(STORAGE_KEY)).toBe("WORKSPACE-BYTES");
    expect(removeProgress(s)).toBe(true);
    expect(s.data.has(PROGRESS_KEY)).toBe(false);
    expect(s.data.get(STORAGE_KEY)).toBe("WORKSPACE-BYTES");
  });

  it.each([
    "{not json",
    "[]",
    '{"version":2}',
    '{"version":1,"lesson":"x","read":"yes","terms":[],"choice":null,"checked":null,"solved":false}',
    '{"version":1,"lesson":"x","read":true,"terms":[1],"choice":null,"checked":null,"solved":false}',
    JSON.stringify({ ...freshProgress("x"), terms: Array.from({ length: 13 }, (_, i) => `t${i}`) }),
  ])("treats %s as corrupt", (raw) => {
    expect(parseProgress(raw)).toEqual({ kind: "corrupt" });
  });

  it("reports unreadable storage as unavailable and failed writes or removals as false", () => {
    expect(loadProgress(null)).toEqual({ kind: "unavailable" });
    expect(loadProgress(memory({}, { failRead: true }))).toEqual({ kind: "unavailable" });
    expect(saveProgress(memory({}, { failWrite: true }), freshProgress("x"))).toBe(false);
    expect(removeProgress(memory({}, { failRemove: true }))).toBe(false);
    expect(loadProgress(memory())).toEqual({ kind: "empty" });
  });
});
