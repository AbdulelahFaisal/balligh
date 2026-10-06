import { useEffect, useRef, useState } from "react";
import { ApiError, isAbort } from "./api";
import { LOCALES, type Locale } from "./types";

export const TOPICS = ["understanding_islam", "belief", "worship", "conduct"] as const;
export type Topic = (typeof TOPICS)[number];
export type ApiCollection = "fatwas" | "hadith";
export type TranslationStatus = "original" | "available" | "unavailable";

export const LIST_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;
export const MAX_QUERY = 80;
export const MAX_PAGE = 10000;

export const PUBLISHER_HOSTS: ReadonlySet<string> = new Set(["quranenc.com", "binbaz.org.sa", "hadeethenc.com", "dorar.net"]);

export interface Run {
  kind: "text" | "strong" | "quran" | "hadith" | "noteref";
  text: string;
  note?: string;
  /** Machine-translation payloads only: a published translation of the meanings resolved for a quran run. */
  published?: PublishedAyah | null;
}
export type Paragraph = Run[];

export interface PublishedAyah {
  surah: number;
  ayah: number;
  text: string;
  edition: string;
}

export interface MachineTranslation {
  locale: string;
  label: "ai_assisted";
  model?: string;
  prompt_version?: string;
  generated_at?: string;
  title: string;
  question: Paragraph[];
  answer: Paragraph[];
  notes?: { id: string; paragraphs: Paragraph[] }[];
}

export interface Note {
  id: string;
  runs: Run[];
}

export interface WordMeaning {
  word: string;
  meaning: string;
}

export type ArabicMatch = "exact" | "not_provided";

export const HONORIFIC_GLYPHS: Readonly<Record<string, string>> = {
  F049: "سبحانه وتعالى",
  F055: "عز وجل",
  F074: "رضي الله عنه",
  F079: "رضي الله عنهم",
};

export type GlyphPart =
  | { kind: "text"; text: string }
  | { kind: "honorific"; code: string; text: string }
  | { kind: "unresolved"; code: string };

const PRIVATE_USE_CHAR = /^[-\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]$/u;
export const HAS_PRIVATE_USE = /[-\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;

export function splitGlyphs(text: string, map: Readonly<Record<string, string>> | null = HONORIFIC_GLYPHS): GlyphPart[] {
  const parts: GlyphPart[] = [];
  let buf = "";
  for (const ch of text) {
    if (!PRIVATE_USE_CHAR.test(ch)) {
      buf += ch;
      continue;
    }
    if (buf) parts.push({ kind: "text", text: buf });
    buf = "";
    const code = ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    const mapped = map ? map[code] : undefined;
    parts.push(mapped ? { kind: "honorific", code, text: mapped } : { kind: "unresolved", code });
  }
  if (buf) parts.push({ kind: "text", text: buf });
  return parts;
}

export const noteAnchor = (recordId: string, noteId: string) => `note-${recordId}-${noteId}`;
export const noteRefAnchor = (recordId: string, noteId: string) => `noteref-${recordId}-${noteId}`;

export interface NoteLink {
  href: string;
  id: string | null;
}

export interface NoteLinks {
  refs: Record<string, NoteLink>;
  backs: Record<string, string | null>;
  targets: Record<string, string>;
}

export const runKey = (group: number, para: number, run: number) => `${group}.${para}.${run}`;

export function buildNoteLinks(recordId: string, groups: Paragraph[][], notes: Note[] | null | undefined): NoteLinks {
  const targets: Record<string, string> = {};
  const backs: Record<string, string | null> = {};
  const refs: Record<string, NoteLink> = {};
  for (const n of Array.isArray(notes) ? notes : []) {
    if (!n || typeof n.id !== "string" || n.id in targets) continue;
    targets[n.id] = noteAnchor(recordId, n.id);
    backs[n.id] = null;
  }
  groups.forEach((paras, g) =>
    paras.forEach((para, p) =>
      para.forEach((run, r) => {
        if (run.kind !== "noteref" || typeof run.note !== "string" || !(run.note in targets)) return;
        const first = backs[run.note] === null;
        const id = first ? noteRefAnchor(recordId, run.note) : null;
        if (first) backs[run.note] = id;
        refs[runKey(g, p, r)] = { href: `#${targets[run.note]}`, id };
      }),
    ),
  );
  return { refs, backs, targets };
}

export interface CollectionSummary {
  count?: number;
  topics?: string[];
  locales?: Record<string, number>;
}

export interface LibraryIndex {
  collections: {
    quran?: Record<string, unknown> & { range?: QuranRange };
    fatwa?: CollectionSummary;
    hadith?: CollectionSummary;
  };
}

export interface QuranRange {
  kind: "full" | "juz_amma";
  surah_first: number;
  surah_last: number;
  surah_count: number;
  ayah_count: number;
}

export interface QuranEdition {
  key: string;
  locale: string;
  direction?: string;
  title: string;
  description?: string;
  version?: string;
  browse_url?: string;
  last_update?: number;
  metadata_source?: string;
  api_template?: string;
  retrieved_at?: string;
  ayah_count?: number;
  footnote_ayahs?: number;
}

export interface QuranTafsir {
  key: string;
  locale?: string;
  title?: string;
  original_publisher?: string;
  delivery?: string;
  label?: string;
  version?: string;
  browse_url?: string;
  retrieved_at?: string;
}

export interface SurahSummary {
  number: number;
  name_ar: string;
  ayah_count: number;
}

export interface QuranIndex {
  range: QuranRange;
  arabic: { label: string; source: string };
  editions: QuranEdition[];
  tafsir: QuranTafsir[];
  surahs: SurahSummary[];
}

export interface Ayah {
  aya: number;
  arabic: string;
  translation: string | null;
  footnotes: string | null;
  tafsir?: string | null;
}

export interface Surah {
  number: number;
  name_ar: string;
  ayah_count: number;
  locale: string;
  translation_status: TranslationStatus;
  edition: QuranEdition | null;
  dir?: string;
  tafsir?: QuranTafsir | null;
  content_sha256?: string;
  prev: number | null;
  next: number | null;
  ayahs: Ayah[];
}

export interface ListItem {
  id: string;
  title: string;
  topic: string;
  reference: string | null;
  translated_title: string | null;
  /** Fatwa lists only: the translated title comes from an AI-assisted translation. */
  machine_translated?: boolean;
}

export interface ListPage {
  total: number;
  page: number;
  page_size: number;
  topics: string[];
  items: ListItem[];
}

export interface SourceCategory {
  id: string;
  label: string;
  url?: string;
}

export interface FatwaRecord {
  id: string;
  title: string;
  question: Paragraph[];
  answer: Paragraph[];
  topic: string;
  source_categories: SourceCategory[];
  source: {
    publisher: string;
    publisher_name?: string | null;
    url: string;
    retrieved_at?: string;
    edition?: string | null;
    series?: string | null;
  };
  reuse_basis?: string;
  review_status?: string;
  raw_sha256?: string;
  content_sha256?: string;
  schema?: string;
  notes?: Note[] | null;
}

export interface FatwaTranslation {
  title?: string | null;
  question?: Paragraph[];
  answer?: Paragraph[];
  source_url?: string | null;
}

export interface HadithRecord {
  id: string;
  title: string;
  text: string;
  attribution: string | null;
  reference?: string | null;
  grade: string | null;
  grading_authority: string | null;
  narrator: string | null;
  explanation: string | null;
  hints: string[];
  topic: string;
  source_categories: SourceCategory[];
  source: { publisher: string; url: string; api_url?: string; retrieved_at?: string };
  dorar: { status: string; reason?: string | null } | null;
  reuse_basis?: string;
  review_status?: string;
  content_sha256?: string;
  schema?: string;
  words_meanings?: WordMeaning[] | null;
}

export interface HadithTranslation {
  title: string | null;
  text: string | null;
  attribution: string | null;
  grade: string | null;
  explanation: string | null;
  hints: string[] | null;
  source_url: string | null;
  api_url?: string | null;
  retrieved_at?: string | null;
  source_language_code?: string | null;
  mapping?: string | null;
  content_sha256?: string | null;
  words_meanings?: WordMeaning[] | null;
  words_meanings_language?: string | null;
  arabic_match?: ArabicMatch | null;
}

export function wordMeanings(x: unknown): WordMeaning[] {
  if (!Array.isArray(x)) return [];
  return x.filter(
    (w): w is WordMeaning =>
      !!w && typeof w === "object" && typeof (w as WordMeaning).word === "string" && typeof (w as WordMeaning).meaning === "string",
  );
}

export interface Detail<R, T> {
  record: R;
  locale: string;
  translation_status: TranslationStatus;
  translation: T | null;
  dir?: string;
  available_locales?: string[];
  machine_translation?: MachineTranslation | null;
  /** Fatwas only: locales that have a valid AI-assisted translation. */
  machine_locales?: string[];
}

export const isTopic = (x: unknown): x is Topic => typeof x === "string" && (TOPICS as readonly string[]).includes(x);
export const isLocale = (x: unknown): x is Locale => typeof x === "string" && (LOCALES as readonly string[]).includes(x);

export function boundQuery(q: unknown): string {
  if (typeof q !== "string") return "";
  return Array.from(q.replace(/[\u0000-\u001f\u007f]/g, " ").trim())
    .slice(0, MAX_QUERY)
    .join("")
    .trim();
}

function toInt(x: unknown): number {
  if (typeof x === "number") return x;
  if (typeof x !== "string" || !/^\d{1,9}$/.test(x.trim())) return NaN;
  return Number.parseInt(x.trim(), 10);
}

export function boundPage(x: unknown): number {
  const n = toInt(x);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_PAGE) : 1;
}

export function boundPageSize(x: unknown): number {
  const n = toInt(x);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_PAGE_SIZE) : LIST_PAGE_SIZE;
}

export function surahNumber(x: unknown): number | null {
  const n = toInt(x);
  return Number.isInteger(n) && n >= 1 && n <= 114 ? n : null;
}

export interface ListParams {
  topic?: string | null;
  q?: string | null;
  locale?: string | null;
  page?: number | string | null;
  pageSize?: number | string | null;
}

export function listUrl(collection: ApiCollection, p: ListParams = {}): string {
  const s = new URLSearchParams();
  if (isTopic(p.topic)) s.set("topic", p.topic);
  const q = boundQuery(p.q);
  if (q) s.set("q", q);
  if (isLocale(p.locale)) s.set("locale", p.locale);
  s.set("page", String(boundPage(p.page)));
  s.set("page_size", String(boundPageSize(p.pageSize)));
  return `/api/library/${collection}?${s}`;
}

export function itemUrl(collection: ApiCollection, id: string, locale: string): string {
  const s = new URLSearchParams();
  if (isLocale(locale)) s.set("locale", locale);
  const qs = s.toString();
  return `/api/library/${collection}/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`;
}

export function surahUrl(n: number, locale: string, tafsir: string | null = null): string {
  const s = new URLSearchParams();
  if (isLocale(locale)) s.set("locale", locale);
  if (tafsir && /^[a-z0-9_]{1,64}$/.test(tafsir)) s.set("tafsir", tafsir);
  const qs = s.toString();
  return `/api/library/quran/${surahNumber(n) ?? 1}${qs ? `?${qs}` : ""}`;
}

export interface BrowseState {
  topic: Topic | null;
  q: string;
  page: number;
  lang: Locale | null;
}

export function readBrowse(search: URLSearchParams): BrowseState {
  const topic = search.get("topic");
  const lang = search.get("lang");
  return {
    topic: isTopic(topic) ? topic : null,
    q: boundQuery(search.get("q")),
    page: boundPage(search.get("page")),
    lang: isLocale(lang) ? lang : null,
  };
}

export function browseSearch(state: Partial<BrowseState> & { tafsir?: boolean }): string {
  const s = new URLSearchParams();
  if (isLocale(state.lang)) s.set("lang", state.lang);
  if (isTopic(state.topic)) s.set("topic", state.topic);
  const q = boundQuery(state.q);
  if (q) s.set("q", q);
  const page = boundPage(state.page);
  if (page > 1) s.set("page", String(page));
  if (state.tafsir) s.set("tafsir", "1");
  const qs = s.toString();
  return qs ? `?${qs}` : "";
}

export function publisherUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 2000 || /[\s\u0000-\u001f]/.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  if (parsed.port && parsed.port !== "443") return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  return PUBLISHER_HOSTS.has(host) ? parsed.href : null;
}

export function publisherHost(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { signal, headers: { Accept: "application/json" } });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ApiError("network", 0);
  }
  if (!res.ok) {
    let detail: unknown = null;
    try {
      detail = ((await res.json()) as { detail?: unknown } | null)?.detail;
    } catch (e) {
      if (isAbort(e)) throw e;
    }
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      const d = detail as { code?: unknown; message?: unknown };
      throw new ApiError(
        typeof d.message === "string" ? d.message : res.statusText,
        res.status,
        [],
        typeof d.code === "string" ? d.code : null,
      );
    }
    throw new ApiError(typeof detail === "string" ? detail : res.statusText, res.status);
  }
  return (await res.json()) as T;
}

export const libraryApi = {
  index: (signal?: AbortSignal) => get<LibraryIndex>("/api/library", signal),
  quran: (signal?: AbortSignal) => get<QuranIndex>("/api/library/quran", signal),
  surah: (n: number, locale: string, tafsir: string | null, signal?: AbortSignal) =>
    get<Surah>(surahUrl(n, locale, tafsir), signal),
  list: (collection: ApiCollection, params: ListParams, signal?: AbortSignal) =>
    get<ListPage>(listUrl(collection, params), signal),
  fatwa: (id: string, locale: string, signal?: AbortSignal) =>
    get<Detail<FatwaRecord, FatwaTranslation>>(itemUrl("fatwas", id, locale), signal),
  hadith: (id: string, locale: string, signal?: AbortSignal) =>
    get<Detail<HadithRecord, HadithTranslation>>(itemUrl("hadith", id, locale), signal),
};

export interface Ticket {
  id: number;
  key: string;
  signal: AbortSignal;
  current: () => boolean;
}

export interface RequestGuard {
  begin: (key: string) => Ticket;
  end: (ticket: Ticket) => void;
  latest: () => number;
}

export function createRequestGuard(): RequestGuard {
  let latest = 0;
  let latestKey: string | null = null;
  let controller: AbortController | null = null;
  return {
    begin(key) {
      controller?.abort();
      const own = new AbortController();
      controller = own;
      latest += 1;
      latestKey = key;
      const id = latest;
      return { id, key, signal: own.signal, current: () => id === latest && key === latestKey && !own.signal.aborted };
    },
    end(ticket) {
      if (ticket.id !== latest) return;
      controller?.abort();
      controller = null;
      latest += 1;
      latestKey = null;
    },
    latest: () => latest,
  };
}

export type Outcome<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export function runGuarded<T>(
  guard: RequestGuard,
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  apply: (outcome: Outcome<T>) => void,
): () => void {
  const ticket = guard.begin(key);
  let pending: Promise<T>;
  try {
    pending = load(ticket.signal);
  } catch (e) {
    pending = Promise.reject(e);
  }
  pending.then(
    (data) => {
      if (ticket.current()) apply({ ok: true, data });
    },
    (e: unknown) => {
      if (!ticket.current() || isAbort(e)) return;
      apply({ ok: false, error: e instanceof ApiError ? e : new ApiError(String(e), 0) });
    },
  );
  return () => guard.end(ticket);
}

export type Resource<T> =
  | { status: "loading"; key: string }
  | { status: "ready"; key: string; data: T }
  | { status: "error"; key: string; error: ApiError };

export function useGuardedResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>) {
  const guard = useRef<RequestGuard | null>(null);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<Resource<T> | null>(null);
  useEffect(() => {
    if (key === null) return;
    guard.current ??= createRequestGuard();
    setState({ status: "loading", key });
    return runGuarded(guard.current, key, load, (o) =>
      setState(o.ok ? { status: "ready", key, data: o.data } : { status: "error", key, error: o.error }),
    );
  }, [key, nonce]);
  const view: Resource<T> | null = key === null ? null : state && state.key === key ? state : { status: "loading", key };
  return { state: view, retry: () => setNonce((n) => n + 1) };
}
