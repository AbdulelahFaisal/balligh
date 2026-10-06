import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import {
  boundQuery,
  browseSearch,
  createRequestGuard,
  itemUrl,
  listUrl,
  MAX_QUERY,
  publisherUrl,
  readBrowse,
  runGuarded,
  surahUrl,
  buildNoteLinks,
  HONORIFIC_GLYPHS,
  splitGlyphs,
  wordMeanings,
  type Outcome,
  type Paragraph,
} from "./library";

describe("splitGlyphs", () => {
  it("maps the four verified Ibn Baz honorific glyphs to Arabic text", () => {
    expect(splitGlyphs("")).toEqual([{ kind: "honorific", code: "F049", text: "سبحانه وتعالى" }]);
    expect(splitGlyphs("")).toEqual([{ kind: "honorific", code: "F055", text: "عز وجل" }]);
    expect(splitGlyphs("")).toEqual([{ kind: "honorific", code: "F074", text: "رضي الله عنه" }]);
    expect(splitGlyphs("")).toEqual([{ kind: "honorific", code: "F079", text: "رضي الله عنهم" }]);
    expect(Object.keys(HONORIFIC_GLYPHS).sort()).toEqual(["F049", "F055", "F074", "F079"]);
  });

  it("keeps an unknown private-use character unresolved", () => {
    expect(splitGlyphs("")).toEqual([{ kind: "unresolved", code: "F0AA" }]);
    expect(splitGlyphs("\u{F0001}")).toEqual([{ kind: "unresolved", code: "F0001" }]);
  });

  it("keeps the surrounding text of mixed runs in order", () => {
    expect(splitGlyphs("قال الله : عن جابر  و آخر")).toEqual([
      { kind: "text", text: "قال الله " },
      { kind: "honorific", code: "F055", text: "عز وجل" },
      { kind: "text", text: ": عن جابر " },
      { kind: "honorific", code: "F074", text: "رضي الله عنه" },
      { kind: "text", text: " و" },
      { kind: "unresolved", code: "F0AA" },
      { kind: "text", text: " آخر" },
    ]);
    expect(splitGlyphs("نص عادي")).toEqual([{ kind: "text", text: "نص عادي" }]);
    expect(splitGlyphs("")).toEqual([]);
  });

  it("leaves every glyph unresolved outside the Ibn Baz context", () => {
    expect(splitGlyphs("أ  ب", null)).toEqual([
      { kind: "text", text: "أ " },
      { kind: "unresolved", code: "F049" },
      { kind: "text", text: " ب" },
    ]);
  });
});

describe("buildNoteLinks", () => {
  const question: Paragraph[] = [[{ kind: "text", text: "سؤال" }, { kind: "noteref", text: "[2]", note: "2" }]];
  const answer: Paragraph[] = [
    [{ kind: "text", text: "جواب" }, { kind: "noteref", text: "[1]", note: "1" }],
    [
      { kind: "noteref", text: "[2]", note: "2" },
      { kind: "noteref", text: "[9]", note: "9" },
    ],
  ];
  const notes = [
    { id: "1", runs: [{ kind: "text" as const, text: "حاشية أولى" }] },
    { id: "2", runs: [{ kind: "text" as const, text: "حاشية ثانية" }] },
    { id: "3", runs: [{ kind: "text" as const, text: "بلا إشارة" }] },
  ];

  it("links every reference to its note and gives only the first reference a back target", () => {
    const links = buildNoteLinks("binbaz-1", [question, answer], notes);
    expect(links.targets).toEqual({ "1": "note-binbaz-1-1", "2": "note-binbaz-1-2", "3": "note-binbaz-1-3" });
    expect(links.refs).toEqual({
      "0.0.1": { href: "#note-binbaz-1-2", id: "noteref-binbaz-1-2" },
      "1.0.1": { href: "#note-binbaz-1-1", id: "noteref-binbaz-1-1" },
      "1.1.0": { href: "#note-binbaz-1-2", id: null },
    });
    expect(links.backs).toEqual({ "1": "noteref-binbaz-1-1", "2": "noteref-binbaz-1-2", "3": null });
  });

  it("handles records without notes", () => {
    expect(buildNoteLinks("x", [answer], undefined)).toEqual({ refs: {}, backs: {}, targets: {} });
    expect(buildNoteLinks("x", [answer], null).refs).toEqual({});
  });
});

describe("wordMeanings", () => {
  it("keeps only well-formed word entries", () => {
    expect(wordMeanings([{ word: "أ", meaning: "ب" }, { word: 1 }, null, "x"])).toEqual([{ word: "أ", meaning: "ب" }]);
    expect(wordMeanings(undefined)).toEqual([]);
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("request guard", () => {
  it("ignores a stale success and applies only the latest request", async () => {
    const guard = createRequestGuard();
    const a = deferred<string>();
    const b = deferred<string>();
    const seen: Outcome<string>[] = [];
    let signalA: AbortSignal | null = null;
    runGuarded(guard, "fatwas|A|en", (s) => ((signalA = s), a.promise), (o) => seen.push(o));
    runGuarded(guard, "fatwas|B|en", () => b.promise, (o) => seen.push(o));
    expect(signalA!.aborted).toBe(true);
    a.resolve("text of A");
    await flush();
    expect(seen).toEqual([]);
    b.resolve("text of B");
    await flush();
    expect(seen).toEqual([{ ok: true, data: "text of B" }]);
  });

  it("ignores a stale failure, so the newer item shows no error", async () => {
    const guard = createRequestGuard();
    const a = deferred<string>();
    const b = deferred<string>();
    const seen: Outcome<string>[] = [];
    runGuarded(guard, "hadith|A|en", () => a.promise, (o) => seen.push(o));
    runGuarded(guard, "hadith|B|en", () => b.promise, (o) => seen.push(o));
    a.reject(new ApiError("boom", 500));
    await flush();
    expect(seen).toEqual([]);
    b.resolve("B");
    await flush();
    expect(seen).toEqual([{ ok: true, data: "B" }]);
  });

  it("treats a locale change of the same item as a new request", async () => {
    const guard = createRequestGuard();
    const en = deferred<string>();
    const fr = deferred<string>();
    const seen: Outcome<string>[] = [];
    runGuarded(guard, "hadith|A|en", () => en.promise, (o) => seen.push(o));
    runGuarded(guard, "hadith|A|fr", () => fr.promise, (o) => seen.push(o));
    fr.resolve("fr");
    await flush();
    en.resolve("en");
    await flush();
    expect(seen).toEqual([{ ok: true, data: "fr" }]);
  });

  it("applies the latest failure and lets a retry of the same key supersede it", async () => {
    const guard = createRequestGuard();
    const first = deferred<string>();
    const second = deferred<string>();
    const seen: Outcome<string>[] = [];
    runGuarded(guard, "quran|2|en", () => first.promise, (o) => seen.push(o));
    first.reject(new ApiError("missing", 404));
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0].ok).toBe(false);
    runGuarded(guard, "quran|2|en", () => second.promise, (o) => seen.push(o));
    second.resolve("ok");
    await flush();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ ok: true, data: "ok" });
  });

  it("drops everything after the owner ends (unmount), including an abort error", async () => {
    const guard = createRequestGuard();
    const a = deferred<string>();
    const seen: Outcome<string>[] = [];
    let signal: AbortSignal | null = null;
    const end = runGuarded(guard, "fatwas|A|ar", (s) => ((signal = s), a.promise), (o) => seen.push(o));
    end();
    expect(signal!.aborted).toBe(true);
    a.reject(new DOMException("aborted", "AbortError"));
    await flush();
    expect(seen).toEqual([]);
  });

  it("ids increase monotonically and only the newest ticket is current", () => {
    const guard = createRequestGuard();
    const t1 = guard.begin("x");
    const t2 = guard.begin("x");
    expect(t2.id).toBeGreaterThan(t1.id);
    expect(t1.current()).toBe(false);
    expect(t2.current()).toBe(true);
    guard.end(t1);
    expect(t2.current()).toBe(true);
    guard.end(t2);
    expect(t2.current()).toBe(false);
  });
});

describe("query builders", () => {
  it("bounds page_size to 50 and page to at least 1", () => {
    const u = new URL(listUrl("fatwas", { page: 0, pageSize: 500 }), "http://x");
    expect(u.pathname).toBe("/api/library/fatwas");
    expect(u.searchParams.get("page_size")).toBe("50");
    expect(u.searchParams.get("page")).toBe("1");
    const v = new URL(listUrl("hadith", { page: "3", pageSize: "abc" }), "http://x");
    expect(v.searchParams.get("page")).toBe("3");
    expect(v.searchParams.get("page_size")).toBe("20");
    expect(new URL(listUrl("hadith", { page: "-2" }), "http://x").searchParams.get("page")).toBe("1");
  });

  it("bounds q to 80 characters (code points) and trims it", () => {
    const long = "ص".repeat(200);
    const u = new URL(listUrl("fatwas", { q: `  ${long}  ` }), "http://x");
    expect(Array.from(u.searchParams.get("q")!)).toHaveLength(MAX_QUERY);
    expect(Array.from(boundQuery("😀".repeat(100)))).toHaveLength(MAX_QUERY);
    expect(new URL(listUrl("fatwas", { q: "   " }), "http://x").searchParams.has("q")).toBe(false);
  });

  it("drops unknown topics and locales", () => {
    const u = new URL(listUrl("fatwas", { topic: "politics", locale: "de" }), "http://x");
    expect(u.searchParams.has("topic")).toBe(false);
    expect(u.searchParams.has("locale")).toBe(false);
    const v = new URL(listUrl("fatwas", { topic: "belief", locale: "zh-Hans" }), "http://x");
    expect(v.searchParams.get("topic")).toBe("belief");
    expect(v.searchParams.get("locale")).toBe("zh-Hans");
  });

  it("encodes item ids and only accepts known tafsir keys", () => {
    expect(itemUrl("fatwas", "binbaz-1/../x", "en")).toBe("/api/library/fatwas/binbaz-1%2F..%2Fx?locale=en");
    expect(surahUrl(2, "ur", "arabic_moyassar")).toBe("/api/library/quran/2?locale=ur&tafsir=arabic_moyassar");
    expect(surahUrl(2, "ur", "x&y=1")).toBe("/api/library/quran/2?locale=ur");
  });

  it("round-trips the browse state through the page URL", () => {
    const qs = browseSearch({ lang: "ur", topic: "worship", q: "صلاة", page: 2 });
    const back = readBrowse(new URLSearchParams(qs));
    expect(back).toEqual({ lang: "ur", topic: "worship", q: "صلاة", page: 2 });
    expect(browseSearch({ page: 1 })).toBe("");
    expect(readBrowse(new URLSearchParams("topic=x&page=zz&lang=xx"))).toEqual({
      lang: null,
      topic: null,
      q: "",
      page: 1,
    });
  });

  it("allows only https links to the publisher hosts", () => {
    expect(publisherUrl("https://binbaz.org.sa/fatwas/1")).toBe("https://binbaz.org.sa/fatwas/1");
    expect(publisherUrl("https://www.hadeethenc.com/ar/browse/hadith/1")).not.toBeNull();
    expect(publisherUrl("http://quranenc.com/en")).toBeNull();
    expect(publisherUrl("https://youtube.com/x")).toBeNull();
    expect(publisherUrl("javascript:alert(1)")).toBeNull();
    expect(publisherUrl("https://dorar.net.evil.example/")).toBeNull();
  });
});
