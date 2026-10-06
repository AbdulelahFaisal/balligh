import { describe, expect, it } from "vitest";
import {
  activeAyah,
  boundaryStep,
  createGuard,
  firstAyahOfPage,
  pageMap,
  parseAyahInput,
  planFor,
  surahsOnPage,
  waitForEvent,
  type SurahTiming,
} from "./quranAudio";

const pages = pageMap({
  pages: [
    [582, [[78, 1], [78, 2]]],
    [583, [[79, 1], [78, 31], [79, 2]]],
  ],
});

const t78: SurahTiming = {
  surah: 78,
  track_url: "https://cdn.mp3quran.net/audio/yasser-dosari/r1/078.mp3",
  timing_url: "",
  ayahs: [
    [1, 7180, 13360, 582],
    [2, 13360, 16880, 582],
    [31, 147360, 152140, 583],
  ],
  unavailable: [{ ayah: 3, page: 582, reason: "no publisher timing row" }],
};
const t79: SurahTiming = {
  surah: 79,
  track_url: "https://cdn.mp3quran.net/audio/yasser-dosari/r1/079.mp3",
  timing_url: "",
  ayahs: [
    [1, 120, 2980, 583],
    [2, 2980, 6000, 583],
  ],
  unavailable: [],
};
const timings = new Map([
  [78, t78],
  [79, t79],
]);

describe("page selection", () => {
  it("resolves the first ayah of a page in Quran order across surahs", () => {
    expect(firstAyahOfPage(pages, 583)).toEqual([78, 31]);
    expect(surahsOnPage(pages, 583)).toEqual([78, 79]);
    expect(firstAyahOfPage(pages, 999)).toBeNull();
  });

  it("plans page playback as consecutive track segments ending at the page boundary", () => {
    const plan = planFor({ kind: "page", page: 583 }, pages, timings);
    expect(plan).toEqual({
      ok: true,
      segments: [
        { surah: 78, track: t78.track_url, fromAyah: 31, toAyah: 31, startS: 147.36, endS: 152.14 },
        { surah: 79, track: t79.track_url, fromAyah: 1, toAyah: 2, startS: 0.12, endS: 6 },
      ],
    });
  });

  it("waits for missing surah timing instead of guessing", () => {
    expect(planFor({ kind: "page", page: 583 }, pages, new Map([[78, t78]]))).toBeNull();
  });
});

describe("ayah selection", () => {
  it("starts at the exact ayah and stops at the surah end", () => {
    const plan = planFor({ kind: "ayah", surah: 78, ayah: 2 }, pages, timings);
    expect(plan).toMatchObject({ ok: true, segments: [{ startS: 13.36, endS: 152.14, fromAyah: 2 }] });
  });

  it("disables an ayah without verified timing and never falls back to the surah start", () => {
    expect(planFor({ kind: "ayah", surah: 78, ayah: 3 }, pages, timings)).toEqual({
      ok: false,
      reason: "no publisher timing row",
      surah: 78,
      ayah: 3,
    });
  });
});

describe("boundaries and highlighting", () => {
  const plan = planFor({ kind: "page", page: 583 }, pages, timings);
  const segments = plan && plan.ok ? plan.segments : [];

  it("continues to the next surah track and stops at the end of the page", () => {
    expect(boundaryStep(segments, 0, 150)).toBe("continue");
    expect(boundaryStep(segments, 0, 152.14)).toBe("next");
    expect(boundaryStep(segments, 0, 149, true)).toBe("next");
    expect(boundaryStep(segments, 1, 5.9)).toBe("continue");
    expect(boundaryStep(segments, 1, 6)).toBe("stop");
  });

  it("highlights only inside verified intervals of the current segment", () => {
    expect(activeAyah(t78, segments[0], 148)).toBe(31);
    expect(activeAyah(t78, segments[0], 10)).toBeNull();
    expect(activeAyah(t79, segments[1], 3)).toBe(2);
  });
});

describe("selection identity guard", () => {
  it("rejects late events from a superseded selection", () => {
    const guard = createGuard();
    const first = guard.next();
    const second = guard.next();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it("lets a late play resolution pause only when no newer selection owns the element", () => {
    const guard = createGuard();
    const old = guard.next();
    expect(guard.claim(old)).toBe(true);
    const stopped = guard.next();
    expect(guard.owns(old)).toBe(true);
    expect(guard.claim(old)).toBe(false);
    const newer = guard.next();
    expect(guard.claim(newer)).toBe(true);
    expect(guard.owns(old)).toBe(false);
    expect(guard.owns(stopped)).toBe(false);
  });

  it("cancels only the superseded operation's waits and removes their listeners", async () => {
    const guard = createGuard();
    const target = new EventTarget();
    const live = new Map<string, number>();
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type: string, fn: EventListenerOrEventListenerObject | null) => {
      live.set(type, (live.get(type) ?? 0) + 1);
      add(type, fn);
    };
    target.removeEventListener = (type: string, fn: EventListenerOrEventListenerObject | null) => {
      live.set(type, (live.get(type) ?? 0) - 1);
      remove(type, fn);
    };
    const old = guard.next();
    const oldWait = waitForEvent(target, "seeked", () => false, guard.signal(old)!);
    expect(live.get("seeked")).toBe(1);
    const newer = guard.next();
    await expect(oldWait).rejects.toMatchObject({ name: "AbortError" });
    expect(live.get("seeked")).toBe(0);
    expect(live.get("error")).toBe(0);
    expect(guard.signal(old)).toBeNull();
    const newWait = waitForEvent(target, "seeked", () => false, guard.signal(newer)!);
    target.dispatchEvent(new Event("seeked"));
    await expect(newWait).resolves.toBeUndefined();
    expect(live.get("seeked")).toBe(0);
  });
});

describe("parseAyahInput", () => {
  it("accepts Latin, Arabic-Indic, Extended Arabic-Indic and Bengali digits", () => {
    expect(parseAyahInput("7", 7)).toBe(7);
    expect(parseAyahInput(" 12 ", 286)).toBe(12);
    expect(parseAyahInput("٢٥٥", 286)).toBe(255);
    expect(parseAyahInput("۱۲", 286)).toBe(12);
    expect(parseAyahInput("৩", 7)).toBe(3);
  });
  it("rejects partial, out-of-range and non-numeric input so nothing seeks", () => {
    for (const bad of ["", "   ", "0", "٠", "8", "-1", "+2", "1.5", "1e2", "abc", "١a", "12345"]) {
      expect(parseAyahInput(bad, 7)).toBeNull();
    }
  });
});
