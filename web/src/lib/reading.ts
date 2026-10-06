import { useEffect, useState, useSyncExternalStore } from "react";
import { isAbort } from "./api";
import { libraryApi, surahNumber, type FatwaRecord, type HadithRecord, type Surah } from "./library";

export const READING_KEY = "balligh.reading.v1";
export const READING_SCHEMA = "balligh.reading/1";

export type ReadingCollection = "quran" | "fatwa" | "hadith";

export interface ReadingLocation {
  collection: ReadingCollection;
  id: string;
  version: string;
  sha256: string;
  anchor: string;
  title: string;
  href: string;
}

export interface ReadingRecord extends ReadingLocation {
  saved_at: string;
}

export type ReadingNotice = "malformed" | "unavailable" | "write_failed" | null;

export type ReadingLoad =
  | { kind: "empty" }
  | { kind: "ok"; record: ReadingRecord }
  | { kind: "malformed" }
  | { kind: "unavailable" };

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const COLLECTIONS: readonly ReadingCollection[] = ["quran", "fatwa", "hadith"];
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,95}$/;
const SHA = /^(sha256:)?[0-9a-f]{64}$/;
const ANCHOR = /^[A-Za-z][A-Za-z0-9_-]{0,159}$/;
const PATHS: Record<ReadingCollection, string> = { quran: "quran", fatwa: "questions", hadith: "hadith" };

export const normalizeSha = (s: string) => s.replace(/^sha256:/, "");

export function hrefMatches(loc: Pick<ReadingLocation, "collection" | "id" | "href">): boolean {
  if (typeof loc.href !== "string" || loc.href.length > 600 || /[\s\u0000-\u001f\\]/.test(loc.href)) return false;
  const base = `/library/${PATHS[loc.collection]}/${encodeURIComponent(loc.id)}`;
  if (loc.href !== base && !loc.href.startsWith(`${base}?`) && !loc.href.startsWith(`${base}#`)) return false;
  try {
    const u = new URL(loc.href, "https://balligh.invalid");
    return u.origin === "https://balligh.invalid" && u.pathname === base;
  } catch {
    return false;
  }
}

export function isReadingLocation(x: unknown): x is ReadingLocation {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const r = x as Record<string, unknown>;
  if (!COLLECTIONS.includes(r.collection as ReadingCollection)) return false;
  if (typeof r.id !== "string" || !ID.test(r.id)) return false;
  if (r.collection === "quran" && surahNumber(r.id) === null) return false;
  if (typeof r.version !== "string" || !VERSION.test(r.version)) return false;
  if (typeof r.sha256 !== "string" || !SHA.test(r.sha256)) return false;
  if (typeof r.anchor !== "string" || !ANCHOR.test(r.anchor)) return false;
  if (typeof r.title !== "string" || r.title.length === 0 || r.title.length > 300) return false;
  return typeof r.href === "string" && hrefMatches(r as unknown as ReadingLocation);
}

function isReadingRecord(x: unknown): x is ReadingRecord {
  if (!isReadingLocation(x)) return false;
  const s = (x as unknown as Record<string, unknown>).saved_at;
  return typeof s === "string" && s.length <= 40 && !Number.isNaN(Date.parse(s));
}

export function parseReading(raw: string | null): ReadingLoad {
  if (raw === null) return { kind: "empty" };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: "malformed" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { kind: "malformed" };
  const d = data as Record<string, unknown>;
  if (d.schema !== READING_SCHEMA || !isReadingRecord(d.last)) return { kind: "malformed" };
  const { collection, id, version, sha256, anchor, title, href, saved_at } = d.last;
  return { kind: "ok", record: { collection, id, version, sha256, anchor, title, href, saved_at } };
}

export function loadReading(storage: StorageLike | null): ReadingLoad {
  if (!storage) return { kind: "unavailable" };
  try {
    return parseReading(storage.getItem(READING_KEY));
  } catch {
    return { kind: "unavailable" };
  }
}

export type SaveOutcome = "saved" | "malformed" | "unavailable" | "write_failed" | "invalid";

export function saveReading(storage: StorageLike | null, loc: ReadingLocation, now: Date = new Date()): SaveOutcome {
  if (!isReadingLocation(loc)) return "invalid";
  if (!storage) return "unavailable";
  let raw: string | null;
  try {
    raw = storage.getItem(READING_KEY);
  } catch {
    return "unavailable";
  }
  if (parseReading(raw).kind === "malformed") return "malformed";
  const { collection, id, version, sha256, anchor, title, href } = loc;
  const record: ReadingRecord = { collection, id, version, sha256, anchor, title, href, saved_at: now.toISOString() };
  try {
    storage.setItem(READING_KEY, JSON.stringify({ schema: READING_SCHEMA, last: record }));
  } catch {
    return "write_failed";
  }
  return "saved";
}

export interface CurrentSource {
  version: string;
  sha256: string | null | undefined;
  hasAnchor: (anchor: string) => boolean;
}

export function matchesCurrent(record: ReadingLocation, current: CurrentSource): boolean {
  if (!current.sha256 || !SHA.test(current.sha256)) return false;
  if (normalizeSha(current.sha256) !== normalizeSha(record.sha256)) return false;
  if (current.version !== record.version) return false;
  return current.hasAnchor(record.anchor);
}

export const surahVersion = (s: Pick<Surah, "edition" | "locale">) => s.edition?.version ?? `arabic-${s.locale}`;
export const fatwaVersion = (r: Pick<FatwaRecord, "schema">) => r.schema ?? "fatwa";
export const hadithVersion = (r: Pick<HadithRecord, "schema">) => r.schema ?? "hadith";

export function surahSource(s: Surah): CurrentSource {
  return {
    version: surahVersion(s),
    sha256: s.content_sha256,
    hasAnchor: (a) => {
      const m = /^ayah-(\d{1,3})$/.exec(a);
      return !!m && Number(m[1]) >= 1 && Number(m[1]) <= s.ayah_count;
    },
  };
}

export function fatwaSource(r: FatwaRecord): CurrentSource {
  const notes = new Set((Array.isArray(r.notes) ? r.notes : []).map((n) => `note-${r.id}-${n?.id}`));
  return {
    version: fatwaVersion(r),
    sha256: r.content_sha256,
    hasAnchor: (a) => a === "fatwa-question" || a === "fatwa-answer" || notes.has(a),
  };
}

export function hadithSource(r: HadithRecord): CurrentSource {
  return {
    version: hadithVersion(r),
    sha256: r.content_sha256,
    hasAnchor: (a) => a === "hadith-text" || (a === "hadith-explanation" && (!!r.explanation || r.hints.length > 0)),
  };
}

interface StoreState {
  record: ReadingRecord | null;
  notice: ReadingNotice;
}

let state: StoreState | null = null;
const listeners = new Set<() => void>();

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function current(): StoreState {
  if (state) return state;
  const loaded = loadReading(browserStorage());
  state =
    loaded.kind === "ok"
      ? { record: loaded.record, notice: null }
      : { record: null, notice: loaded.kind === "empty" ? null : loaded.kind };
  return state;
}

function emit(next: StoreState) {
  state = next;
  listeners.forEach((l) => l());
}

export function recordReading(loc: ReadingLocation): SaveOutcome | "unchanged" {
  if (!isReadingLocation(loc)) return "invalid";
  const prev = current();
  if (
    prev.record &&
    prev.record.collection === loc.collection &&
    prev.record.id === loc.id &&
    prev.record.version === loc.version &&
    prev.record.sha256 === loc.sha256 &&
    prev.record.anchor === loc.anchor &&
    prev.record.href === loc.href &&
    prev.notice === null
  )
    return "unchanged";
  const now = new Date();
  const outcome = saveReading(browserStorage(), loc, now);
  const { collection, id, version, sha256, anchor, title, href } = loc;
  const record: ReadingRecord = { collection, id, version, sha256, anchor, title, href, saved_at: now.toISOString() };
  emit({ record, notice: outcome === "saved" || outcome === "invalid" ? null : outcome });
  return outcome;
}

export function sameSource(a: ReadingLocation | null, b: ReadingLocation): boolean {
  return (
    !!a &&
    a.collection === b.collection &&
    a.id === b.id &&
    a.version === b.version &&
    normalizeSha(a.sha256) === normalizeSha(b.sha256)
  );
}

export function recordOpened(loc: ReadingLocation): SaveOutcome | "unchanged" {
  if (!isReadingLocation(loc)) return "invalid";
  if (sameSource(current().record, loc)) return "unchanged";
  return recordReading(loc);
}

export function anchorFromHash(hash: string | null | undefined): string | null {
  if (typeof hash !== "string" || hash.length < 2 || hash.length > 200) return null;
  let a: string;
  try {
    a = decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return null;
  }
  return ANCHOR.test(a) ? a : null;
}

export type RestoreDecision = { kind: "none" } | { kind: "restore"; anchor: string } | { kind: "stale"; anchor: string } | { kind: "missing"; anchor: string };

export function restoreDecision(
  anchor: string | null,
  saved: ReadingRecord | null,
  loaded: { collection: ReadingCollection; id: string },
  source: CurrentSource,
): RestoreDecision {
  if (!anchor) return { kind: "none" };
  if (
    saved &&
    saved.collection === loaded.collection &&
    saved.id === loaded.id &&
    saved.anchor === anchor &&
    !matchesCurrent(saved, source)
  )
    return { kind: "stale", anchor };
  if (!source.hasAnchor(anchor)) return { kind: "missing", anchor };
  return { kind: "restore", anchor };
}

export function resetReadingStore(): void {
  state = null;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useReadingState(): StoreState {
  return useSyncExternalStore(subscribe, current, current);
}

export type ContinueState =
  | { status: "none" }
  | { status: "checking"; record: ReadingRecord }
  | { status: "valid"; record: ReadingRecord }
  | { status: "stale"; record: ReadingRecord };

function hrefLocale(href: string): string {
  try {
    return new URL(href, "https://balligh.invalid").searchParams.get("lang") ?? "ar";
  } catch {
    return "ar";
  }
}

export async function checkReading(record: ReadingRecord, signal?: AbortSignal): Promise<boolean> {
  const locale = hrefLocale(record.href);
  if (record.collection === "quran") {
    const n = surahNumber(record.id);
    if (n === null) return false;
    return matchesCurrent(record, surahSource(await libraryApi.surah(n, locale, null, signal)));
  }
  if (record.collection === "fatwa") {
    const d = await libraryApi.fatwa(record.id, locale, signal);
    return d.record.id === record.id && matchesCurrent(record, fatwaSource(d.record));
  }
  const d = await libraryApi.hadith(record.id, locale, signal);
  return d.record.id === record.id && matchesCurrent(record, hadithSource(d.record));
}

export function useContinueReading(): { state: ContinueState; notice: ReadingNotice } {
  const { record, notice } = useReadingState();
  const [checked, setChecked] = useState<{ key: string; ok: boolean } | null>(null);
  const key = record ? `${record.collection}|${record.id}|${record.version}|${record.sha256}|${record.anchor}|${record.href}` : null;
  useEffect(() => {
    if (!record || key === null) return;
    const ctrl = new AbortController();
    checkReading(record, ctrl.signal).then(
      (ok) => {
        if (!ctrl.signal.aborted) setChecked({ key, ok });
      },
      (e: unknown) => {
        if (!ctrl.signal.aborted && !isAbort(e)) setChecked({ key, ok: false });
      },
    );
    return () => ctrl.abort();
  }, [key]);
  if (!record) return { state: { status: "none" }, notice };
  if (!checked || checked.key !== key) return { state: { status: "checking", record }, notice };
  return { state: { status: checked.ok ? "valid" : "stale", record }, notice };
}
