export const ASSISTANT_PATH = "/api/assistant/ask";
export const MAX_QUESTION = 1000;
export const HISTORY_LIMIT = 4;

export type AssistantMode = "site_help" | "fatwa" | "hadith" | "quran";
export type AssistantStatus = "answered" | "not_in_sources" | "needs_qualified_help" | "quran_extract";
export type AnswerKind = "ai_explanation" | "published_extract";
export type EvidenceKind =
  | "help"
  | "arabic_original"
  | "published_translation"
  | "publisher_explanation"
  | "grade_reference"
  | "note"
  | "quran_arabic"
  | "quran_translation"
  | "quran_footnote"
  | "quran_tafsir";

export interface RecordContext {
  record_id: string;
  sha256: string;
  version: string;
}

export interface QuranContext {
  surah: number;
  ayah: number;
  sha256: string;
  version: string;
  tafsir: boolean;
}

export type AskScope =
  | { mode: "site_help"; context: null }
  | { mode: "fatwa" | "hadith"; context: RecordContext }
  | { mode: "quran"; context: QuranContext };

export interface AskBody {
  request_id: string;
  mode: AssistantMode;
  locale: string;
  question: string;
  context: RecordContext | QuranContext | null;
}

export interface EvidenceSource {
  title: string;
  publisher: string | null;
  sha256: string | null;
  version: string | null;
  edition: string | null;
}

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  label: string;
  text: string;
  lang: string;
  dir: "rtl" | "ltr";
  href: string | null;
  url: string | null;
  source: EvidenceSource;
}

export interface AnswerParagraph {
  text: string;
  evidence: string[];
}

export interface AskReply {
  request_id: string;
  mode: AssistantMode;
  locale: string;
  status: AssistantStatus;
  answer_kind: AnswerKind;
  paragraphs: AnswerParagraph[];
  evidence: Evidence[];
  scope: { mode: AssistantMode; title: string; href: string };
  meta: {
    model: string | null;
    prompt_version: string;
    latency_ms: number | null;
    provider_calls: number;
    usage: Record<string, unknown> | null;
  };
}

export class AssistantError extends Error {
  status: number;
  code: string | null;
  retryable: boolean;
  details: string[];
  constructor(message: string, status: number, code: string | null = null, retryable = false, details: string[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export interface Ticket {
  requestId: string;
  scopeKey: string;
  locale: string;
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function cleanQuestion(raw: string): string | null {
  const q = raw.trim();
  return q.length >= 1 && q.length <= MAX_QUESTION ? q : null;
}

export function scopeKey(scope: AskScope, locale: string): string {
  switch (scope.mode) {
    case "site_help":
      return `site_help|${locale}`;
    case "fatwa":
    case "hadith":
      return [scope.mode, scope.context.record_id, scope.context.sha256, scope.context.version, locale].join("|");
    case "quran":
      return [
        "quran",
        scope.context.surah,
        scope.context.ayah,
        scope.context.sha256,
        scope.context.version,
        scope.context.tafsir ? "tafsir" : "plain",
        locale,
      ].join("|");
  }
}

export function buildAskBody(scope: AskScope, locale: string, raw: string, requestId: string = newRequestId()): AskBody {
  const question = cleanQuestion(raw);
  if (question === null) throw new RangeError("question");
  return { request_id: requestId, mode: scope.mode, locale, question, context: scope.context };
}

export function ticketFor(body: AskBody, scope: AskScope): Ticket {
  return { requestId: body.request_id, scopeKey: scopeKey(scope, body.locale), locale: body.locale };
}

export function sameTicket(a: Ticket | null, b: Ticket | null): boolean {
  return !!a && !!b && a.requestId === b.requestId && a.scopeKey === b.scopeKey && a.locale === b.locale;
}

export function stillApplies(ticket: Ticket, current: Ticket | null, currentScopeKey: string | null, currentLocale: string): boolean {
  return sameTicket(ticket, current) && ticket.scopeKey === currentScopeKey && ticket.locale === currentLocale;
}

export function replyApplies(
  reply: Pick<AskReply, "request_id">,
  ticket: Ticket,
  current: Ticket | null,
  currentScopeKey: string | null,
  currentLocale: string,
): boolean {
  return reply.request_id === ticket.requestId && stillApplies(ticket, current, currentScopeKey, currentLocale);
}

function describe(x: unknown): string {
  const e = x as { loc?: unknown[]; msg?: unknown };
  return Array.isArray(e?.loc) && typeof e?.msg === "string"
    ? `${e.loc.filter((p) => p !== "body").join(".")}: ${e.msg}`
    : JSON.stringify(x);
}

export async function toAssistantError(res: Response): Promise<AssistantError> {
  let body: { detail?: unknown } | null = null;
  try {
    body = await res.json();
  } catch {
    return new AssistantError(res.statusText, res.status);
  }
  const d = body?.detail;
  if (typeof d === "string") return new AssistantError(d, res.status);
  if (Array.isArray(d)) return new AssistantError(res.statusText || "invalid request", res.status, "validation", false, d.map(describe));
  if (d && typeof d === "object") {
    const o = d as Record<string, unknown>;
    return new AssistantError(
      typeof o.message === "string" ? o.message : res.statusText,
      res.status,
      typeof o.code === "string" ? o.code : null,
      o.retryable === true,
    );
  }
  return new AssistantError(res.statusText, res.status);
}

export function isReply(x: unknown): x is AskReply {
  const r = x as Partial<AskReply> | null;
  return (
    !!r &&
    typeof r.request_id === "string" &&
    typeof r.status === "string" &&
    Array.isArray(r.paragraphs) &&
    Array.isArray(r.evidence)
  );
}

export async function askAssistant(body: AskBody, signal?: AbortSignal): Promise<AskReply> {
  const res = await fetch(ASSISTANT_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await toAssistantError(res);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new AssistantError("invalid reply", res.status, "invalid_reply");
  }
  if (!isReply(data) || data.request_id !== body.request_id) throw new AssistantError("invalid reply", res.status, "invalid_reply");
  return data;
}

export function evidenceIndex(reply: Pick<AskReply, "evidence">): Map<string, number> {
  return new Map(reply.evidence.map((e, i) => [e.id, i]));
}

export const TEACHER_PATHS: readonly string[] = ["/setup", "/review", "/preview"];

export interface QuranTarget {
  surah: number;
  name: string;
  sha256: string | null;
  version: string | null;
}

export type SourceScope =
  | { mode: "fatwa" | "hadith"; title: string; locale: string; href: string; context: RecordContext }
  | {
      mode: "quran";
      title: string;
      locale: string;
      href: string;
      edition: string | null;
      tafsir: boolean;
      ayahCount: number;
      route: QuranTarget;
      focus: (QuranTarget & { ayah: number }) | null;
    };

export function quranTarget(scope: Extract<SourceScope, { mode: "quran" }>, picked: number): (QuranTarget & { ayah: number }) {
  if (scope.focus) return scope.focus;
  return { ...scope.route, ayah: Math.min(Math.max(1, Math.trunc(picked) || 1), Math.max(1, scope.ayahCount)) };
}

export function resolveScope(source: SourceScope | null, picked: number): AskScope | null {
  if (!source) return { mode: "site_help", context: null };
  if (source.mode !== "quran") return { mode: source.mode, context: source.context };
  const target = quranTarget(source, picked);
  if (!target.sha256 || !target.version) return null;
  return {
    mode: "quran",
    context: { surah: target.surah, ayah: target.ayah, sha256: target.sha256, version: target.version, tafsir: source.tafsir },
  };
}
