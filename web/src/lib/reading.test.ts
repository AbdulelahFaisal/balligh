import { afterEach, describe, expect, it } from "vitest";
import {
  anchorFromHash,
  fatwaSource,
  isReadingLocation,
  loadReading,
  matchesCurrent,
  parseReading,
  READING_KEY,
  READING_SCHEMA,
  recordOpened,
  recordReading,
  resetReadingStore,
  restoreDecision,
  sameSource,
  saveReading,
  surahSource,
  type ReadingLocation,
  type StorageLike,
} from "./reading";
import type { FatwaRecord, Surah } from "./library";

const SHA = "a".repeat(64);
const LOC: ReadingLocation = {
  collection: "fatwa",
  id: "binbaz-11423",
  version: "balligh.library.fatwa/2",
  sha256: `sha256:${SHA}`,
  anchor: "fatwa-question",
  title: "معنى الإسلام",
  href: "/library/questions/binbaz-11423?lang=ar",
};

function mem(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe("reading location validation", () => {
  it("accepts a real location and rejects foreign hrefs, bad hashes and anchors", () => {
    expect(isReadingLocation(LOC)).toBe(true);
    expect(isReadingLocation({ ...LOC, href: "https://evil.example/library/questions/binbaz-11423" })).toBe(false);
    expect(isReadingLocation({ ...LOC, href: "/library/hadith/binbaz-11423" })).toBe(false);
    expect(isReadingLocation({ ...LOC, href: "/library/questions/binbaz-1" })).toBe(false);
    expect(isReadingLocation({ ...LOC, sha256: "abc" })).toBe(false);
    expect(isReadingLocation({ ...LOC, anchor: "#x y" })).toBe(false);
    expect(isReadingLocation({ ...LOC, collection: "book" })).toBe(false);
    expect(isReadingLocation({ ...LOC, collection: "quran", id: "115", href: "/library/quran/115" })).toBe(false);
    expect(isReadingLocation({ ...LOC, collection: "quran", id: "78", href: "/library/quran/78#ayah-31" })).toBe(true);
  });
});

describe("versioned storage record", () => {
  it("round-trips through the separate reading key", () => {
    const s = mem();
    expect(saveReading(s, LOC, new Date("2026-10-06T09:00:00Z"))).toBe("saved");
    expect(Object.keys(s.data)).toEqual([READING_KEY]);
    expect(JSON.parse(s.data[READING_KEY]).schema).toBe(READING_SCHEMA);
    const loaded = loadReading(s);
    expect(loaded.kind).toBe("ok");
    if (loaded.kind === "ok") expect(loaded.record.anchor).toBe("fatwa-question");
  });

  it("never touches lesson or progress keys", () => {
    const s = mem({ "balligh.workspace.v1": "W", "balligh.progress.v1": "P" });
    saveReading(s, LOC);
    expect(s.data["balligh.workspace.v1"]).toBe("W");
    expect(s.data["balligh.progress.v1"]).toBe("P");
  });

  it("reports malformed data and leaves it untouched", () => {
    for (const raw of ["{not json", JSON.stringify({ schema: "balligh.reading/0", last: LOC }), JSON.stringify({ schema: READING_SCHEMA, last: { ...LOC, sha256: "x" } })]) {
      const s = mem({ [READING_KEY]: raw });
      expect(parseReading(raw).kind).toBe("malformed");
      expect(saveReading(s, LOC)).toBe("malformed");
      expect(s.data[READING_KEY]).toBe(raw);
    }
  });

  it("reports read and write failures without throwing", () => {
    const throwingRead: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => undefined,
    };
    expect(loadReading(throwingRead).kind).toBe("unavailable");
    expect(saveReading(throwingRead, LOC)).toBe("unavailable");
    const full: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    };
    expect(saveReading(full, LOC)).toBe("write_failed");
    expect(saveReading(null, LOC)).toBe("unavailable");
    expect(saveReading(mem(), { ...LOC, anchor: "" })).toBe("invalid");
  });
});

describe("continue only for a location valid in the current source", () => {
  const fatwa = {
    id: "binbaz-11423",
    schema: "balligh.library.fatwa/2",
    content_sha256: `sha256:${SHA}`,
    notes: [{ id: "1", runs: [] }],
  } as unknown as FatwaRecord;

  it("matches hash, version and anchor", () => {
    expect(matchesCurrent(LOC, fatwaSource(fatwa))).toBe(true);
    expect(matchesCurrent({ ...LOC, anchor: "note-binbaz-11423-1" }, fatwaSource(fatwa))).toBe(true);
    expect(matchesCurrent({ ...LOC, anchor: "note-binbaz-11423-9" }, fatwaSource(fatwa))).toBe(false);
  });

  it("rejects a changed content hash or version", () => {
    expect(matchesCurrent(LOC, fatwaSource({ ...fatwa, content_sha256: `sha256:${"b".repeat(64)}` }))).toBe(false);
    expect(matchesCurrent(LOC, fatwaSource({ ...fatwa, schema: "balligh.library.fatwa/3" }))).toBe(false);
    expect(matchesCurrent(LOC, fatwaSource({ ...fatwa, content_sha256: undefined }))).toBe(false);
  });

  it("checks ayah anchors against the surah length", () => {
    const surah = { number: 1, ayah_count: 7, locale: "ar", edition: null, content_sha256: SHA } as unknown as Surah;
    const q: ReadingLocation = { ...LOC, collection: "quran", id: "1", version: "arabic-ar", sha256: SHA, anchor: "ayah-7", href: "/library/quran/1" };
    expect(matchesCurrent(q, surahSource(surah))).toBe(true);
    expect(matchesCurrent({ ...q, anchor: "ayah-8" }, surahSource(surah))).toBe(false);
  });
});

describe("explicit places are not overwritten by reopening the same record", () => {
  const g = globalThis as unknown as { window?: unknown };
  afterEach(() => {
    delete g.window;
    resetReadingStore();
  });
  const answer: ReadingLocation = { ...LOC, anchor: "fatwa-answer" };
  const stored = (s: { data: Record<string, string> }) => JSON.parse(s.data[READING_KEY]).last;

  it("keeps a saved specific anchor when the same record loads again", () => {
    const s = mem({ "balligh.lesson.v1": "LESSON" });
    g.window = { localStorage: s };
    resetReadingStore();
    expect(recordReading(answer)).toBe("saved");
    expect(recordOpened(LOC)).toBe("unchanged");
    expect(recordOpened({ ...LOC, sha256: SHA })).toBe("unchanged");
    expect(stored(s).anchor).toBe("fatwa-answer");
    expect(s.data["balligh.lesson.v1"]).toBe("LESSON");
  });

  it("records a genuinely new record or a changed source", () => {
    const s = mem();
    g.window = { localStorage: s };
    resetReadingStore();
    recordReading(answer);
    expect(recordOpened({ ...LOC, sha256: `sha256:${"b".repeat(64)}` })).toBe("saved");
    expect(stored(s).anchor).toBe("fatwa-question");
    const other: ReadingLocation = { ...LOC, id: "binbaz-2171", href: "/library/questions/binbaz-2171?lang=ar" };
    expect(recordOpened(other)).toBe("saved");
    expect(stored(s).id).toBe("binbaz-2171");
  });

  it("an explicit save replaces the anchor and reports the real outcome", () => {
    const s = mem();
    g.window = { localStorage: s };
    resetReadingStore();
    expect(recordReading(LOC)).toBe("saved");
    expect(recordReading(LOC)).toBe("unchanged");
    expect(recordReading(answer)).toBe("saved");
    expect(stored(s).anchor).toBe("fatwa-answer");
    expect(recordReading({ ...LOC, anchor: "1bad" })).toBe("invalid");
  });

  it("keeps malformed bytes and an in-memory place when storage cannot be used", () => {
    const s = mem({ [READING_KEY]: "{broken" });
    g.window = { localStorage: s };
    resetReadingStore();
    expect(recordReading(answer)).toBe("malformed");
    expect(s.data[READING_KEY]).toBe("{broken");
    expect(recordOpened(LOC)).toBe("unchanged");
    const failing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    g.window = { localStorage: failing };
    resetReadingStore();
    expect(recordReading(answer)).toBe("write_failed");
    expect(recordOpened(LOC)).toBe("unchanged");
  });

  it("compares sources with or without the sha256 prefix", () => {
    expect(sameSource(LOC, { ...LOC, sha256: SHA, anchor: "fatwa-answer" })).toBe(true);
    expect(sameSource(LOC, { ...LOC, version: "balligh.library.fatwa/3" })).toBe(false);
    expect(sameSource(null, LOC)).toBe(false);
  });
});

describe("restoring a place only when it is real", () => {
  const fatwa = {
    id: "binbaz-11423",
    schema: "balligh.library.fatwa/2",
    content_sha256: `sha256:${SHA}`,
    notes: [],
  } as unknown as FatwaRecord;
  const saved = { ...LOC, anchor: "fatwa-answer", saved_at: "2026-10-06T10:00:00.000Z" };
  const here = { collection: "fatwa" as const, id: "binbaz-11423" };

  it("reads only well-formed anchors from the hash", () => {
    expect(anchorFromHash("#fatwa-answer")).toBe("fatwa-answer");
    expect(anchorFromHash("")).toBeNull();
    expect(anchorFromHash("#")).toBeNull();
    expect(anchorFromHash("#1x")).toBeNull();
    expect(anchorFromHash("#a%ZZ")).toBeNull();
    expect(anchorFromHash("#a b")).toBeNull();
  });

  it("restores a matching anchor and refuses stale or missing ones", () => {
    expect(restoreDecision(null, saved, here, fatwaSource(fatwa))).toEqual({ kind: "none" });
    expect(restoreDecision("fatwa-answer", saved, here, fatwaSource(fatwa))).toEqual({ kind: "restore", anchor: "fatwa-answer" });
    expect(restoreDecision("fatwa-answer", null, here, fatwaSource(fatwa))).toEqual({ kind: "restore", anchor: "fatwa-answer" });
    const changed = fatwaSource({ ...fatwa, content_sha256: `sha256:${"b".repeat(64)}` });
    expect(restoreDecision("fatwa-answer", saved, here, changed)).toEqual({ kind: "stale", anchor: "fatwa-answer" });
    const newer = fatwaSource({ ...fatwa, schema: "balligh.library.fatwa/3" });
    expect(restoreDecision("fatwa-answer", saved, here, newer)).toEqual({ kind: "stale", anchor: "fatwa-answer" });
    expect(restoreDecision("note-binbaz-11423-7", null, here, fatwaSource(fatwa))).toEqual({ kind: "missing", anchor: "note-binbaz-11423-7" });
  });
});
