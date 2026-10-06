export const LOCALES = ["ar", "en", "ur", "zh-Hans", "id", "bn", "fr"] as const;
export type Locale = (typeof LOCALES)[number];
export const RTL_LOCALES: ReadonlySet<string> = new Set(["ar", "ur"]);
export const dirOf = (loc: string): "rtl" | "ltr" => (RTL_LOCALES.has(loc) ? "rtl" : "ltr");

export const LOCALE_NAMES: Record<Locale, string> = {
  ar: "العربية",
  en: "English",
  ur: "اردو",
  "zh-Hans": "简体中文",
  id: "Bahasa Indonesia",
  bn: "বাংলা",
  fr: "Français",
};

export type Level = "foundational" | "detailed";

export interface SourceRecord {
  id: string;
  kind: string;
  publisher: string | null;
  title: string;
  canonical_url: string | null;
  local_reference: string | null;
  source_version: string;
  retrieved_at: string;
  rights_url: string | null;
  rights_status: string;
  content_sha256: string;
  language: Locale;
  attribution_status: string;
  is_test_data: boolean;
  provenance_note: string;
}

/** Teacher-supplied Arabic text embedded in a draft. The server derives id, version and hash from the exact text. */
export interface TeacherSource {
  id: string;
  version: string;
  content_sha256: string;
  title: string;
  text: string;
  language: "ar";
  declared_reference: string;
}

export interface TeacherLimits {
  max_words: number;
  max_chars: number;
  max_sentences: number;
  max_title_chars: number;
  max_reference_chars: number;
}

export interface SourceSpan {
  id: string;
  source_id: string;
  source_version: string;
  source_sha256: string;
  start_offset: number;
  end_offset: number;
  segment_ids: string[];
  exact_text: string;
  text_sha256: string;
}

export type Derivation =
  | "verbatim_quote"
  | "team_translation"
  | "derived_explanation"
  | "machine_translation"
  | "machine_explanation";

export interface LessonCard {
  id: string;
  kind: "quote" | "explanation" | "term_note";
  source_span_ids: string[];
  text: string;
  quote_id: string | null;
  derivation: Derivation;
  editor_note: string;
}

export interface LessonTerm {
  term_id: string;
  source_form: string;
  display_form: string;
  meaning: string;
  source_ids: string[];
}

export interface LessonActivity {
  question: string;
  options: { id: string; text: string }[];
  correct_option_id: string;
  rationale: string;
  source_span_ids: string[];
}

export interface TokenUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  prompt_cache_hit_tokens: number | null;
  prompt_cache_miss_tokens: number | null;
  reasoning_tokens: number | null;
}

export interface AuthoredGeneration {
  origin: "fixture" | "manual";
  note: string;
  human_edited?: boolean;
  last_human_edit_at?: string | null;
  [key: string]: unknown;
}

export interface LiveGeneration {
  origin: "live";
  provider: string;
  requested_model: string;
  returned_model: string | null;
  prompt_version: string;
  request_id: string;
  generated_at: string;
  source_sha256: string;
  glossary_sha256: string;
  settings: { thinking: string; reasoning_effort: string; response_format: string; max_tokens: number };
  usage: TokenUsage | null;
  latency_ms: number | null;
  note: string;
  human_edited: boolean;
  last_human_edit_at: string | null;
}

export type GenerationInfo = AuthoredGeneration | LiveGeneration;

export interface LessonDraft {
  id: string;
  schema_version: "balligh.lesson/1";
  is_test_data: boolean;
  title: string;
  source_ids: string[];
  spans: SourceSpan[];
  input_hash: string;
  target_locale: Locale;
  level: Level;
  glossary_version: string;
  cards: LessonCard[];
  terms: LessonTerm[];
  activity: LessonActivity;
  generation: GenerationInfo;
  validation_findings: string[];
  presentation: { font_scale: number };
  teacher_source?: TeacherSource;
}

export interface ReviewRecord {
  lesson_hash: string;
  source_hashes: Record<string, string>;
  glossary_version: string;
  locale: Locale;
  reviewer_label: string;
  reviewer_role_self_declared: string;
  reviewed_at: string;
  scope: "whole_lesson";
  status: "acknowledged_by_user";
  verification: "none_local_self_declared";
  notes: string;
}

export type ReviewStatus = "draft" | "needs_correction" | "stale" | "acknowledged_by_user" | "team_published";

export interface Evaluation {
  valid: boolean;
  errors: string[];
  lesson_hash: string;
  status: ReviewStatus;
}
