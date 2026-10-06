import type { LessonDraft } from "./types";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export function semanticPayload(draft: LessonDraft) {
  return {
    schema_version: draft.schema_version,
    title: draft.title,
    source_ids: [...draft.source_ids].sort(),
    spans: [...draft.spans]
      .map(({ text_sha256: _ignored, ...span }) => span)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    target_locale: draft.target_locale,
    level: draft.level,
    glossary_version: draft.glossary_version,
    cards: draft.cards,
    terms: draft.terms,
    activity: draft.activity,
    ...(draft.teacher_source ? { teacher_source: draft.teacher_source } : {}),
  };
}

export function semanticKey(draft: LessonDraft): string {
  const text = canonical(semanticPayload(draft));
  return `${draft.id}:${hash53(text)}${text.length.toString(16)}`;
}

export type FieldPath =
  | "title"
  | `card:${string}:text`
  | `term:${string}:display_form`
  | `term:${string}:meaning`
  | "activity:question"
  | `option:${string}:text`
  | "activity:rationale";

export function emptyFields(draft: LessonDraft): Set<FieldPath> {
  const out = new Set<FieldPath>();
  const blank = (s: string) => s.trim() === "";
  if (blank(draft.title)) out.add("title");
  for (const c of draft.cards) if (blank(c.text)) out.add(`card:${c.id}:text`);
  for (const t of draft.terms) {
    if (blank(t.display_form)) out.add(`term:${t.term_id}:display_form`);
    if (blank(t.meaning)) out.add(`term:${t.term_id}:meaning`);
  }
  if (blank(draft.activity.question)) out.add("activity:question");
  for (const o of draft.activity.options) if (blank(o.text)) out.add(`option:${o.id}:text`);
  if (blank(draft.activity.rationale)) out.add("activity:rationale");
  return out;
}
