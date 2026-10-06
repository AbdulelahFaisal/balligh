import { afterEach, describe, expect, it } from "vitest";
import fixtureJson from "../../../content/examples/g1-citation-lesson-en.json";
import {
  autosave,
  browserStorage,
  loadSaved,
  parseSaved,
  recoveryOf,
  STORAGE_KEY,
  tryReset,
  trySave,
  type StorageLike,
} from "./storage";
import type { LessonDraft, ReviewRecord } from "./types";

const fixture = fixtureJson as unknown as LessonDraft;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const review: ReviewRecord = {
  lesson_hash: "sha256:" + "a".repeat(64),
  source_hashes: { "src-g1-local-note-ar": "g1-fixture-1:" + "b".repeat(64) },
  glossary_version: "g1-fixture-glossary-1",
  locale: "en",
  reviewer_label: "Tester",
  reviewer_role_self_declared: "",
  reviewed_at: "2026-10-06T00:00:00Z",
  scope: "whole_lesson",
  status: "acknowledged_by_user",
  verification: "none_local_self_declared",
  notes: "",
};

interface Probe extends StorageLike {
  data: Map<string, string>;
  writes: number;
}

function memoryStorage(
  initial?: string,
  opts: { failWrite?: Error; failRead?: boolean; failRemove?: boolean } = {},
): Probe {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(STORAGE_KEY, initial);
  const s: Probe = {
    data,
    writes: 0,
    getItem: (k) => {
      if (opts.failRead) throw new DOMException("read blocked", "SecurityError");
      return data.get(k) ?? null;
    },
    setItem: (k, v) => {
      s.writes += 1;
      if (opts.failWrite) throw opts.failWrite;
      data.set(k, v);
    },
    removeItem: (k) => {
      if (opts.failRemove) throw new DOMException("remove blocked", "SecurityError");
      data.delete(k);
    },
  };
  return s;
}

const stored = (draft: unknown, rev: unknown = null) => JSON.stringify({ version: 1, draft, review: rev });
const reasonOf = (raw: string) => {
  const r = parseSaved(raw);
  return r.kind === "unreadable" ? r.reason : r.kind;
};

describe("parseSaved: basic cases (G1-N11)", () => {
  it("accepts empty and a valid version-1 workspace, with and without a review", () => {
    expect(parseSaved(null).kind).toBe("empty");
    expect(parseSaved(stored(fixture)).kind).toBe("ok");
    expect(parseSaved(stored(fixture, review)).kind).toBe("ok");
  });

  it("keeps malformed JSON as unreadable raw bytes", () => {
    expect(parseSaved("{not json")).toEqual({ kind: "unreadable", raw: "{not json", reason: "malformed_json" });
  });

  it("flags unsupported versions and non-object payloads", () => {
    const raw = JSON.stringify({ version: 2, draft: fixture, review: null });
    expect(parseSaved(raw)).toMatchObject({ kind: "unreadable", reason: "unsupported_version", raw });
    expect(reasonOf("[1,2]")).toBe("invalid_structure");
    expect(reasonOf('"text"')).toBe("invalid_structure");
  });
});

describe("parseSaved: nested structure is checked before rendering (P2 item 1)", () => {
  const breakers: Record<string, (d: LessonDraft) => unknown> = {
    "terms contains null": (d) => ({ ...d, terms: [null] }),
    "terms item is a string": (d) => ({ ...d, terms: ["x"] }),
    "term meaning is an object": (d) => ({ ...d, terms: [{ ...d.terms[0], meaning: { a: 1 } }] }),
    "activity.options contains null": (d) => ({ ...d, activity: { ...d.activity, options: [null] } }),
    "activity option text is an object": (d) => ({
      ...d,
      activity: { ...d.activity, options: [{ id: "a", text: { x: 1 } }, d.activity.options[1]] },
    }),
    "activity.question is an object": (d) => ({ ...d, activity: { ...d.activity, question: { text: "q" } } }),
    "activity.rationale is a number": (d) => ({ ...d, activity: { ...d.activity, rationale: 5 } }),
    "cards[0].editor_note is an object": (d) => ({ ...d, cards: [{ ...d.cards[0], editor_note: { n: 1 } }, ...d.cards.slice(1)] }),
    "cards[0].text is an array": (d) => ({ ...d, cards: [{ ...d.cards[0], text: ["x"] }, ...d.cards.slice(1)] }),
    "cards contains null": (d) => ({ ...d, cards: [null] }),
    "card source_span_ids contains a number": (d) => ({ ...d, cards: [{ ...d.cards[0], source_span_ids: [1] }] }),
    "card quote_id is a number": (d) => ({ ...d, cards: [{ ...d.cards[0], quote_id: 7 }] }),
    "card derivation is an object": (d) => ({ ...d, cards: [{ ...d.cards[0], derivation: {} }] }),
    "spans contains null": (d) => ({ ...d, spans: [null] }),
    "span exact_text is an object": (d) => ({ ...d, spans: [{ ...d.spans[0], exact_text: {} }] }),
    "span offset is a string": (d) => ({ ...d, spans: [{ ...d.spans[0], start_offset: "0" }] }),
    "span source_id is an object": (d) => ({ ...d, spans: [{ ...d.spans[0], source_id: {} }] }),
    "source_ids contains an object": (d) => ({ ...d, source_ids: [{}] }),
    "title is an object": (d) => ({ ...d, title: { a: 1 } }),
    "title is null": (d) => ({ ...d, title: null }),
    "generation is null": (d) => ({ ...d, generation: null }),
    "presentation.font_scale is a string": (d) => ({ ...d, presentation: { font_scale: "1" } }),
    "presentation is missing": (d) => ({ ...d, presentation: undefined }),
    "validation_findings contains null": (d) => ({ ...d, validation_findings: [null] }),
    "is_test_data is missing": (d) => ({ ...d, is_test_data: undefined }),
  };

  it.each(Object.keys(breakers))("rejects: %s", (name) => {
    const raw = stored(breakers[name](clone(fixture)));
    const r = parseSaved(raw);
    expect(r).toEqual({ kind: "unreadable", raw, reason: "invalid_structure" });
  });

  const reviewBreakers: Record<string, unknown> = {
    "reviewer_label is an object": { ...review, reviewer_label: { x: 1 } },
    "source_hashes value is a number": { ...review, source_hashes: { a: 1 } },
    "source_hashes is an array": { ...review, source_hashes: [] },
    "notes is missing": { ...review, notes: undefined },
    "status is a number": { ...review, status: 1 },
  };
  it.each(Object.keys(reviewBreakers))("rejects a review whose %s", (name) => {
    expect(reasonOf(stored(fixture, reviewBreakers[name]))).toBe("invalid_structure");
  });

  it("rejects a review stored without a draft", () => {
    expect(reasonOf(stored(null, review))).toBe("invalid_structure");
  });
});

describe("parseSaved: safe incomplete drafts stay recoverable (P2 item 1)", () => {
  const incomplete: Record<string, (d: LessonDraft) => LessonDraft> = {
    "empty title": (d) => ({ ...d, title: "" }),
    "empty card text": (d) => ({ ...d, cards: [{ ...d.cards[0], text: "" }, ...d.cards.slice(1)] }),
    "empty editor note": (d) => ({ ...d, cards: [{ ...d.cards[0], editor_note: "" }, ...d.cards.slice(1)] }),
    "empty activity question": (d) => ({ ...d, activity: { ...d.activity, question: "" } }),
    "empty term meaning": (d) => ({ ...d, terms: [{ ...d.terms[0], meaning: "" }, ...d.terms.slice(1)] }),
    "empty option text": (d) => ({ ...d, activity: { ...d.activity, options: [{ id: "a", text: "" }, d.activity.options[1]] } }),
    "no terms": (d) => ({ ...d, terms: [] }),
    "unknown derivation text": (d) => ({ ...d, cards: [{ ...d.cards[0], derivation: "something_else" as never }] }),
  };
  it.each(Object.keys(incomplete))("keeps: %s", (name) => {
    const r = parseSaved(stored(incomplete[name](clone(fixture))));
    expect(r.kind).toBe("ok");
  });

  it("preserves the exact in-progress values", () => {
    const d = { ...clone(fixture), title: "" };
    const r = parseSaved(stored(d));
    expect(r.kind === "ok" && r.saved.draft?.title).toBe("");
  });
});

describe("unreadable and unavailable storage (P2 items 1-3)", () => {
  it("does not touch unreadable bytes on load, and allows zero automatic writes", () => {
    const s = memoryStorage("{garbage");
    const r = loadSaved(s);
    expect(r.kind).toBe("unreadable");
    expect(autosave(s, { version: 1, draft: fixture, review: null }, recoveryOf(r) !== null)).toBe("paused");
    expect(s.writes).toBe(0);
    expect(s.data.get(STORAGE_KEY)).toBe("{garbage");
  });

  it("treats a failing getItem as unavailable, not empty, with setItem available: zero writes", () => {
    const existing = stored(fixture, review);
    const s = memoryStorage(existing, { failRead: true });
    const r = loadSaved(s);
    expect(r).toEqual({ kind: "unavailable", reason: "read_failed" });
    expect(recoveryOf(r)).not.toBeNull();
    expect(autosave(s, { version: 1, draft: null, review: null }, recoveryOf(r) !== null)).toBe("paused");
    expect(s.writes).toBe(0);
    expect(s.data.get(STORAGE_KEY)).toBe(existing);
  });

  it("treats inaccessible storage as unavailable and never as empty", () => {
    expect(loadSaved(null)).toEqual({ kind: "unavailable", reason: "storage_inaccessible" });
    expect(autosave(null, { version: 1, draft: null, review: null }, true)).toBe("paused");
  });

  it("browserStorage() reports inaccessible storage as null instead of throwing", () => {
    expect(browserStorage()).toBeNull();
    const g = globalThis as unknown as { window?: unknown };
    g.window = {
      get localStorage(): never {
        throw new DOMException("denied", "SecurityError");
      },
    };
    expect(browserStorage()).toBeNull();
    expect(loadSaved(browserStorage())).toEqual({ kind: "unavailable", reason: "storage_inaccessible" });
  });

  it("only a successful read confirming absence allows ordinary saving", () => {
    const s = memoryStorage();
    const r = loadSaved(s);
    expect(r.kind).toBe("empty");
    expect(recoveryOf(r)).toBeNull();
    expect(autosave(s, { version: 1, draft: fixture, review: null }, false)).toBe("saved");
    expect(s.writes).toBe(1);
  });

  it("a failed reset keeps the data and reports failure; a successful reset resumes saving", () => {
    const bytes = "{garbage";
    const blocked = memoryStorage(bytes, { failRemove: true });
    expect(tryReset(blocked)).toBe(false);
    expect(blocked.data.get(STORAGE_KEY)).toBe(bytes);
    expect(blocked.writes).toBe(0);
    expect(tryReset(null)).toBe(false);

    const ok = memoryStorage(bytes);
    expect(tryReset(ok)).toBe(true);
    expect(ok.data.has(STORAGE_KEY)).toBe(false);
    expect(autosave(ok, { version: 1, draft: fixture, review: null }, false)).toBe("saved");
    expect(loadSaved(ok).kind).toBe("ok");
  });
});

describe("write failures stay truthful (existing behaviour kept)", () => {
  it("reports quota-exceeded and denied writes as failures", () => {
    const saved = { version: 1 as const, draft: fixture, review: null };
    expect(trySave(memoryStorage(undefined, { failWrite: new DOMException("full", "QuotaExceededError") }), saved)).toBe(false);
    expect(trySave(memoryStorage(undefined, { failWrite: new DOMException("denied", "SecurityError") }), saved)).toBe(false);
    expect(trySave(null, saved)).toBe(false);
    expect(autosave(memoryStorage(undefined, { failWrite: new DOMException("full", "QuotaExceededError") }), saved, false)).toBe("failed");
  });
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("parseSaved: embedded teacher text is shape-checked before rendering (G5B-R02)", () => {
  const snap = {
    id: "teacher-0123456789abcdef",
    version: "teacher-1",
    content_sha256: "c".repeat(64),
    title: "Title",
    text: "نص المعلم.",
    language: "ar",
    declared_reference: "",
  };
  const withTeacher = (teacher: unknown) => JSON.stringify({ version: 1, draft: { ...clone(fixture), teacher_source: teacher }, review: null });

  it("accepts a well-formed embedded teacher text and legacy drafts without one", () => {
    expect(parseSaved(withTeacher(snap)).kind).toBe("ok");
    expect(parseSaved(withTeacher(null)).kind).toBe("ok");
    expect(parseSaved(JSON.stringify({ version: 1, draft: clone(fixture), review: null })).kind).toBe("ok");
  });

  it.each([
    ["a number", 42],
    ["an empty object", {}],
    ["an object title", { ...snap, title: { x: 1 } }],
    ["an object text", { ...snap, text: { x: 1 } }],
    ["an object reference", { ...snap, declared_reference: ["x"] }],
    ["an empty text", { ...snap, text: "" }],
    ["a forged id", { ...snap, id: "lib-fatwa-18975" }],
    ["a bad hash", { ...snap, content_sha256: "zz" }],
    ["another language", { ...snap, language: "en" }],
  ])("sends %s to recovery with the bytes intact", (_name, teacher) => {
    const raw = withTeacher(teacher);
    const r = parseSaved(raw);
    expect(r.kind).toBe("unreadable");
    if (r.kind === "unreadable") {
      expect(r.reason).toBe("invalid_structure");
      expect(r.raw).toBe(raw);
    }
  });
});
