import type { LessonDraft, ReviewRecord } from "./types";

export const STORAGE_KEY = "balligh.workspace.v1";

export interface Saved {
  version: 1;
  draft: LessonDraft | null;
  review: ReviewRecord | null;
}

export type UnreadableReason = "malformed_json" | "unsupported_version" | "invalid_structure";
export type UnavailableReason = "storage_inaccessible" | "read_failed";

export type LoadResult =
  | { kind: "empty" }
  | { kind: "ok"; saved: Saved }
  | { kind: "unreadable"; raw: string; reason: UnreadableReason }
  | { kind: "unavailable"; reason: UnavailableReason };

export type Recovery = Extract<LoadResult, { kind: "unreadable" | "unavailable" }>;

export function recoveryOf(r: LoadResult): Recovery | null {
  return r.kind === "unreadable" || r.kind === "unavailable" ? r : null;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const arrOf = (v: unknown, item: (x: unknown) => boolean): boolean => Array.isArray(v) && v.every(item);
const strArray = (v: unknown): boolean => arrOf(v, isStr);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNullable = (v: unknown, check: (x: unknown) => boolean): boolean => v === null || check(v);
const isOptional = (v: unknown, check: (x: unknown) => boolean): boolean => v === undefined || check(v);

const isSpan = (s: unknown): boolean =>
  isObj(s) &&
  isStr(s.id) &&
  isStr(s.source_id) &&
  isStr(s.source_version) &&
  isStr(s.source_sha256) &&
  isNum(s.start_offset) &&
  isNum(s.end_offset) &&
  strArray(s.segment_ids) &&
  isStr(s.exact_text) &&
  isStr(s.text_sha256);

const isCard = (c: unknown): boolean =>
  isObj(c) &&
  isStr(c.id) &&
  isStr(c.kind) &&
  strArray(c.source_span_ids) &&
  isStr(c.text) &&
  (c.quote_id === null || isStr(c.quote_id)) &&
  isStr(c.derivation) &&
  isStr(c.editor_note);

const isTerm = (t: unknown): boolean =>
  isObj(t) &&
  isStr(t.term_id) &&
  isStr(t.source_form) &&
  isStr(t.display_form) &&
  isStr(t.meaning) &&
  strArray(t.source_ids);

const isOption = (o: unknown): boolean => isObj(o) && isStr(o.id) && isStr(o.text);

const isActivity = (a: unknown): boolean =>
  isObj(a) &&
  isStr(a.question) &&
  arrOf(a.options, isOption) &&
  isStr(a.correct_option_id) &&
  isStr(a.rationale) &&
  strArray(a.source_span_ids);

const isUsage = (u: unknown): boolean => isObj(u) && Object.values(u).every((v) => v === null || isNum(v));

const isGeneration = (g: unknown): boolean => {
  if (!isObj(g)) return false;
  if (g.origin === "fixture" || g.origin === "manual")
    return (
      isStr(g.note) &&
      isOptional(g.human_edited, isBool) &&
      isOptional(g.last_human_edit_at, (v) => isNullable(v, isStr))
    );
  return (
    g.origin === "live" &&
    isStr(g.provider) &&
    isStr(g.requested_model) &&
    isNullable(g.returned_model, isStr) &&
    isStr(g.prompt_version) &&
    isStr(g.request_id) &&
    isStr(g.generated_at) &&
    isStr(g.note) &&
    isBool(g.human_edited) &&
    isNullable(g.last_human_edit_at, isStr) &&
    isNullable(g.usage, isUsage) &&
    isNullable(g.latency_ms, isNum)
  );
};

/** G5B-R02: every field the UI consumes from an embedded teacher text; absent and null mean "none". */
function isTeacherSource(t: unknown): boolean {
  return (
    isObj(t) &&
    isStr(t.id) &&
    /^teacher-[0-9a-f]{16}$/.test(t.id) &&
    t.version === "teacher-1" &&
    isStr(t.content_sha256) &&
    /^[0-9a-f]{64}$/.test(t.content_sha256) &&
    isStr(t.title) &&
    isStr(t.text) &&
    t.text.length > 0 &&
    t.language === "ar" &&
    isStr(t.declared_reference)
  );
}

function isDraftShape(d: unknown): d is LessonDraft {
  return (
    isObj(d) &&
    (d.teacher_source === undefined || d.teacher_source === null || isTeacherSource(d.teacher_source)) &&
    d.schema_version === "balligh.lesson/1" &&
    isStr(d.id) &&
    typeof d.is_test_data === "boolean" &&
    isStr(d.title) &&
    strArray(d.source_ids) &&
    arrOf(d.spans, isSpan) &&
    isStr(d.input_hash) &&
    isStr(d.target_locale) &&
    isStr(d.level) &&
    isStr(d.glossary_version) &&
    arrOf(d.cards, isCard) &&
    arrOf(d.terms, isTerm) &&
    isActivity(d.activity) &&
    isGeneration(d.generation) &&
    strArray(d.validation_findings) &&
    isObj(d.presentation) &&
    isNum(d.presentation.font_scale)
  );
}

function isReviewShape(r: unknown): r is ReviewRecord {
  return (
    isObj(r) &&
    isStr(r.lesson_hash) &&
    isObj(r.source_hashes) &&
    Object.values(r.source_hashes).every(isStr) &&
    isStr(r.glossary_version) &&
    isStr(r.locale) &&
    isStr(r.reviewer_label) &&
    isStr(r.reviewer_role_self_declared) &&
    isStr(r.reviewed_at) &&
    isStr(r.scope) &&
    isStr(r.status) &&
    isStr(r.verification) &&
    isStr(r.notes)
  );
}

export function parseSaved(raw: string | null): LoadResult {
  if (raw === null || raw === "") return { kind: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unreadable", raw, reason: "malformed_json" };
  }
  if (!isObj(parsed)) return { kind: "unreadable", raw, reason: "invalid_structure" };
  if (parsed.version !== 1) return { kind: "unreadable", raw, reason: "unsupported_version" };
  const draft = parsed.draft ?? null;
  const review = parsed.review ?? null;
  if (draft !== null && !isDraftShape(draft)) return { kind: "unreadable", raw, reason: "invalid_structure" };
  if (review !== null && !isReviewShape(review)) return { kind: "unreadable", raw, reason: "invalid_structure" };
  if (draft === null && review !== null) return { kind: "unreadable", raw, reason: "invalid_structure" };
  return { kind: "ok", saved: { version: 1, draft, review } };
}

export function loadSaved(storage: StorageLike | null): LoadResult {
  if (!storage) return { kind: "unavailable", reason: "storage_inaccessible" };
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { kind: "unavailable", reason: "read_failed" };
  }
  return parseSaved(raw);
}

export function trySave(storage: StorageLike | null, saved: Saved): boolean {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(saved));
    return true;
  } catch {
    return false;
  }
}

export function autosave(storage: StorageLike | null, saved: Saved, paused: boolean): "saved" | "failed" | "paused" {
  if (paused) return "paused";
  return trySave(storage, saved) ? "saved" : "failed";
}

export function tryReset(storage: StorageLike | null): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
