import type { Evaluation, LessonDraft, Level, Locale, ReviewRecord, SourceRecord, TeacherLimits, TeacherSource } from "./types";

export class ApiError extends Error {
  status: number;
  details: string[];
  code: string | null;
  retryable: boolean;
  diagnosticId: string | null;
  constructor(
    message: string,
    status: number,
    details: string[] = [],
    code: string | null = null,
    retryable = false,
    diagnosticId: string | null = null,
  ) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
    this.retryable = retryable;
    this.diagnosticId = diagnosticId;
  }
}

export const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === "AbortError";

function describe(x: unknown): string {
  if (typeof x === "string") return x;
  const e = x as { loc?: unknown[]; msg?: unknown };
  return Array.isArray(e?.loc) && typeof e?.msg === "string"
    ? `${e.loc.filter((p) => p !== "body").join(".")}: ${e.msg}`
    : JSON.stringify(x);
}

async function toError(res: Response): Promise<ApiError> {
  let body: { detail?: unknown } | null = null;
  try {
    body = await res.json();
  } catch {
    return new ApiError(res.statusText, res.status);
  }
  const d = body?.detail;
  if (typeof d === "string") return new ApiError(d, res.status);
  if (Array.isArray(d)) return new ApiError(res.statusText, res.status, d.map(describe));
  if (d && typeof d === "object") {
    const o = d as Record<string, unknown>;
    return new ApiError(
      String(o.message ?? res.statusText),
      res.status,
      Array.isArray(o.errors) ? o.errors.map(String) : [],
      typeof o.code === "string" ? o.code : null,
      o.retryable === true,
      typeof o.diagnostic_id === "string" ? o.diagnostic_id : null,
    );
  }
  return new ApiError(res.statusText, res.status);
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ApiError("network", 0);
  }
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export interface Health {
  status: string;
  version: string;
  generation: {
    enabled: boolean;
    configured: boolean;
    provider: string;
    model: string;
    locales: string[];
    max_in_flight: number;
    in_flight: number;
  };
  provider_audio: { enabled: boolean; planned_phase: string };
  product_model: string;
}

export interface LocaleReadiness {
  locale: string;
  dir: string;
  ui_ready: boolean;
  generation_tested: boolean;
  source_translation_available: boolean;
  content_reviewed: boolean;
  audio_tested: boolean;
}

export interface GenerateBody {
  request_id: string;
  source_id: string;
  source_version: string;
  source_sha256: string;
  target_locale: Locale;
  level: Level;
  teacher_source?: TeacherSource;
}

export interface DerivedTeacherSource {
  snapshot: TeacherSource;
  words: number;
  chars: number;
  sentences: number;
  /** Known-ayah matches (heuristic; misses spelling variants and partial quotations) and quotation markers. */
  quran: { matches: { surah: number; ayah: number }[]; markers: number; checked: boolean };
}

export type ExampleSummary = { id: string; title: string; target_locale: string; source_ids: string[] };

export const api = {
  health: () => call<Health>("/api/health"),
  locales: () => call<LocaleReadiness[]>("/api/locales"),
  sources: () => call<SourceRecord[]>("/api/sources"),
  source: (id: string) =>
    call<{ record: SourceRecord; text: string | null }>(`/api/sources/${encodeURIComponent(id)}`),
  examples: () => call<ExampleSummary[]>("/api/examples"),
  example: (id: string) => call<Evaluation & { draft: LessonDraft }>(`/api/examples/${encodeURIComponent(id)}`),
  validate: (draft: LessonDraft, review: ReviewRecord | null) =>
    call<Evaluation>("/api/drafts/validate", post({ draft, review })),
  teacherLimits: () => call<TeacherLimits>("/api/teacher-sources/limits"),
  deriveTeacherSource: (body: { title: string; text: string; declared_reference: string }, signal?: AbortSignal) =>
    call<DerivedTeacherSource>("/api/teacher-sources/derive", { ...post(body), signal }),
  generate: (body: GenerateBody, signal: AbortSignal) =>
    call<Evaluation & { draft: LessonDraft; request_id: string }>("/api/drafts/generate", { ...post(body), signal }),
  acknowledge: (draft: LessonDraft, reviewer_label: string, reviewer_role_self_declared: string) =>
    call<Evaluation & { review: ReviewRecord }>(
      "/api/reviews/acknowledge",
      post({ draft, reviewer_label, reviewer_role_self_declared, confirmed_compared_with_source: true }),
    ),
  exportFile: async (kind: "html" | "json", draft: LessonDraft, review: ReviewRecord | null): Promise<Blob> => {
    let res: Response;
    try {
      res = await fetch(`/api/export/${kind}`, post({ draft, review }));
    } catch {
      throw new ApiError("network", 0);
    }
    if (!res.ok) throw await toError(res);
    return res.blob();
  },
  importFile: (text: string) =>
    call<Evaluation & { draft: LessonDraft; discarded_claims: string[] }>("/api/drafts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: text,
    }),
};
