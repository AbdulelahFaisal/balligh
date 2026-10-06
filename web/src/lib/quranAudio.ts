export type AyahRef = [number, number];
export type TimedAyah = [number, number, number, number];

export interface AudioSummary {
  status: "ready";
  read_id: number;
  reciter: { name_ar: string; name_en: string; rewaya_ar: string; rewaya_en: string };
  folder_url: string;
  sources: { documentation: string; publisher_page: string };
  units: { raw: string; seconds: string };
  retrieved_at: string;
  dataset_sha256: string;
  pages: [number, AyahRef[]][];
}

export interface SurahTiming {
  surah: number;
  track_url: string;
  timing_url: string;
  ayahs: TimedAyah[];
  unavailable: { ayah: number; page: number | null; reason: string }[];
}

export type Selection = { kind: "ayah"; surah: number; ayah: number } | { kind: "page"; page: number };

export interface Segment {
  surah: number;
  track: string;
  fromAyah: number;
  toAyah: number;
  startS: number;
  endS: number;
}

export type Plan = { ok: true; segments: Segment[] } | { ok: false; reason: string; surah: number; ayah: number };

export const msToSeconds = (ms: number) => ms / 1000;

export function pageMap(summary: Pick<AudioSummary, "pages">): Map<number, AyahRef[]> {
  return new Map(summary.pages.map(([p, refs]) => [p, refs]));
}

export function pagesForSurah(pages: Map<number, AyahRef[]>, surah: number): number[] {
  const out: number[] = [];
  for (const [p, refs] of pages) if (refs.some(([s]) => s === surah)) out.push(p);
  return out.sort((a, b) => a - b);
}

export function pageOfAyah(pages: Map<number, AyahRef[]>, surah: number, ayah: number): number | null {
  for (const [p, refs] of pages) if (refs.some(([s, a]) => s === surah && a === ayah)) return p;
  return null;
}

export function firstAyahOfPage(pages: Map<number, AyahRef[]>, page: number): AyahRef | null {
  const refs = pages.get(page);
  if (!refs || refs.length === 0) return null;
  return [...refs].sort((x, y) => x[0] - y[0] || x[1] - y[1])[0];
}

export function surahsOnPage(pages: Map<number, AyahRef[]>, page: number): number[] {
  return [...new Set((pages.get(page) ?? []).map(([s]) => s))].sort((a, b) => a - b);
}

function timed(timing: SurahTiming, ayah: number): TimedAyah | null {
  return timing.ayahs.find((a) => a[0] === ayah) ?? null;
}

export function unavailableReason(timing: SurahTiming, ayah: number): string | null {
  if (timed(timing, ayah)) return null;
  return timing.unavailable.find((u) => u.ayah === ayah)?.reason ?? "no verified timing";
}

function segment(timing: SurahTiming, from: number, to: number): Segment | { reason: string; ayah: number } {
  const first = timed(timing, from);
  if (!first) return { reason: unavailableReason(timing, from) ?? "no verified timing", ayah: from };
  let last: TimedAyah | null = null;
  for (let a = to; a >= from && !last; a--) last = timed(timing, a);
  return {
    surah: timing.surah,
    track: timing.track_url,
    fromAyah: from,
    toAyah: to,
    startS: msToSeconds(first[1]),
    endS: msToSeconds((last ?? first)[2]),
  };
}

export function planFor(
  selection: Selection,
  pages: Map<number, AyahRef[]>,
  timings: Map<number, SurahTiming>,
): Plan | null {
  if (selection.kind === "ayah") {
    const timing = timings.get(selection.surah);
    if (!timing) return null;
    const lastAyah = Math.max(...timing.ayahs.map((a) => a[0]), ...timing.unavailable.map((u) => u.ayah));
    const seg = segment(timing, selection.ayah, lastAyah);
    return "reason" in seg ? { ok: false, reason: seg.reason, surah: selection.surah, ayah: seg.ayah } : { ok: true, segments: [seg] };
  }
  const refs = [...(pages.get(selection.page) ?? [])].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  if (refs.length === 0) return { ok: false, reason: "page not in the publisher page map", surah: 0, ayah: 0 };
  const segments: Segment[] = [];
  for (const s of surahsOnPage(pages, selection.page)) {
    const timing = timings.get(s);
    if (!timing) return null;
    const ayahs = refs.filter(([rs]) => rs === s).map(([, a]) => a);
    const seg = segment(timing, ayahs[0], ayahs[ayahs.length - 1]);
    if ("reason" in seg) return { ok: false, reason: seg.reason, surah: s, ayah: seg.ayah };
    segments.push(seg);
  }
  return { ok: true, segments };
}

export function surahsNeeded(selection: Selection, pages: Map<number, AyahRef[]>): number[] {
  return selection.kind === "ayah" ? [selection.surah] : surahsOnPage(pages, selection.page);
}

export function activeAyah(timing: SurahTiming, seg: Segment, t: number): number | null {
  for (const [ayah, start, end] of timing.ayahs) {
    if (ayah < seg.fromAyah || ayah > seg.toAyah) continue;
    if (t >= msToSeconds(start) && t < msToSeconds(end)) return ayah;
  }
  return null;
}

export type Step = "continue" | "next" | "stop";

export function boundaryStep(segments: Segment[], index: number, t: number, ended = false): Step {
  const seg = segments[index];
  if (!seg) return "stop";
  if (!ended && t < seg.endS) return "continue";
  return index + 1 < segments.length ? "next" : "stop";
}

export function createGuard() {
  let current = 0;
  let owner = 0;
  let ctl = new AbortController();
  return {
    next: () => {
      ctl.abort();
      ctl = new AbortController();
      return ++current;
    },
    isCurrent: (id: number) => id === current,
    claim: (id: number) => {
      if (id === current) owner = id;
      return id === current;
    },
    owns: (id: number) => owner === id,
    signal: (id: number): AbortSignal | null => (id === current ? ctl.signal : null),
    get current() {
      return current;
    },
  };
}

export const superseded = () => Object.assign(new Error("superseded"), { name: "AbortError" });

export function waitForEvent(target: EventTarget, ok: string, ready: () => boolean, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(superseded());
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const off = () => {
      target.removeEventListener(ok, done);
      target.removeEventListener("error", fail);
      signal.removeEventListener("abort", cancel);
    };
    const done = () => {
      off();
      resolve();
    };
    const fail = () => {
      off();
      reject(Object.assign(new Error("media error"), { name: "MediaError" }));
    };
    const cancel = () => {
      off();
      reject(superseded());
    };
    target.addEventListener(ok, done);
    target.addEventListener("error", fail);
    signal.addEventListener("abort", cancel);
  });
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const quranAudioApi = {
  summary: (signal?: AbortSignal) => getJson<AudioSummary>("/api/library/quran-audio", signal),
  surah: (n: number, signal?: AbortSignal) => getJson<SurahTiming>(`/api/library/quran-audio/${n}`, signal),
};

/* Zero code points of the digit sets a learner may type: Latin, Arabic-Indic,
   Extended Arabic-Indic (Urdu/Persian) and Bengali. */
const DIGIT_ZEROS = [0x30, 0x660, 0x6f0, 0x9e6];

/**
 * Parse a typed ayah number. Returns the ayah only when the whole input is a
 * complete, valid number in 1..max; partial or invalid input returns null so
 * the caller never seeks on it.
 */
export function parseAyahInput(text: string, max: number): number | null {
  const s = text.trim();
  if (!s || s.length > 4) return null;
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const zero = DIGIT_ZEROS.find((z) => cp >= z && cp <= z + 9);
    if (zero === undefined) return null;
    n = n * 10 + (cp - zero);
  }
  return n >= 1 && n <= max ? n : null;
}
