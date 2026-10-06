import type { LessonDraft, SourceRecord, TeacherSource } from "./types";

export const TEACHER_RIGHTS = "teacher_supplied";

/** A display record for a teacher-supplied text. It is never a publisher identity or a review. */
export function teacherRecord(s: TeacherSource): SourceRecord {
  return {
    id: s.id,
    kind: "local_text",
    publisher: null,
    title: s.title,
    canonical_url: null,
    local_reference: null,
    source_version: s.version,
    retrieved_at: "",
    rights_url: null,
    rights_status: TEACHER_RIGHTS,
    content_sha256: s.content_sha256,
    language: s.language,
    attribution_status: "teacher_claim",
    is_test_data: false,
    provenance_note: s.declared_reference,
  };
}

export function isTeacherRecord(rec: SourceRecord | null | undefined): boolean {
  return !!rec && rec.rights_status === TEACHER_RIGHTS;
}

/** The registry view for one draft: the global records plus the draft's own embedded teacher text. */
export function sourcesForDraft(
  draft: LessonDraft | null | undefined,
  global: Record<string, SourceRecord>,
): Record<string, SourceRecord> {
  const s = draft?.teacher_source;
  return s ? { ...global, [s.id]: teacherRecord(s) } : global;
}

/** The exact text of a teacher source embedded in the draft, or null for library sources. */
export function sourceTextFor(draft: LessonDraft | null | undefined, id: string): string | null {
  const s = draft?.teacher_source;
  return s && s.id === id ? s.text : null;
}
