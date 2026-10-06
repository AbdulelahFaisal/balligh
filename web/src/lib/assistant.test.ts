import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askAssistant,
  AssistantError,
  buildAskBody,
  cleanQuestion,
  MAX_QUESTION,
  replyApplies,
  resolveScope,
  scopeKey,
  stillApplies,
  ticketFor,
  type AskScope,
} from "./assistant";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = `sha256:${"a".repeat(64)}`;
const FATWA: AskScope = { mode: "fatwa", context: { record_id: "binbaz-11423", sha256: SHA, version: "balligh.library.fatwa/2" } };
const QURAN: AskScope = { mode: "quran", context: { surah: 78, ayah: 31, sha256: SHA, version: "english_saheeh.v1", tafsir: false } };
const SITE: AskScope = { mode: "site_help", context: null };

afterEach(() => vi.unstubAllGlobals());

describe("question and request body", () => {
  it("trims the question and accepts 1 to 1000 characters", () => {
    expect(cleanQuestion("  ما معنى هذا؟  ")).toBe("ما معنى هذا؟");
    expect(cleanQuestion("   ")).toBeNull();
    expect(cleanQuestion("")).toBeNull();
    expect(cleanQuestion("x".repeat(MAX_QUESTION))).toHaveLength(MAX_QUESTION);
    expect(cleanQuestion("x".repeat(MAX_QUESTION + 1))).toBeNull();
    expect(cleanQuestion(` ${"x".repeat(MAX_QUESTION)} `)).toHaveLength(MAX_QUESTION);
  });

  it("builds exactly the contract fields with a fresh UUID per request", () => {
    const a = buildAskBody(FATWA, "en", "  why?  ");
    const b = buildAskBody(FATWA, "en", "why?");
    expect(Object.keys(a).sort()).toEqual(["context", "locale", "mode", "question", "request_id"]);
    expect(a.request_id).toMatch(UUID);
    expect(b.request_id).toMatch(UUID);
    expect(a.request_id).not.toBe(b.request_id);
    expect(a).toMatchObject({ mode: "fatwa", locale: "en", question: "why?", context: FATWA.context });
    expect(buildAskBody(SITE, "ar", "help").context).toBeNull();
    expect(buildAskBody(QURAN, "en", "q", "fixed").context).toEqual({ surah: 78, ayah: 31, sha256: SHA, version: "english_saheeh.v1", tafsir: false });
    expect(() => buildAskBody(SITE, "ar", "  ")).toThrow(RangeError);
  });
});

describe("scope keys and stale replies", () => {
  it("keys are stable and change with record, hash, version, ayah, tafsir and locale", () => {
    expect(scopeKey(FATWA, "en")).toBe(scopeKey({ ...FATWA }, "en"));
    expect(scopeKey(FATWA, "en")).not.toBe(scopeKey(FATWA, "ar"));
    expect(scopeKey(FATWA, "en")).not.toBe(scopeKey({ mode: "hadith", context: FATWA.context }, "en"));
    expect(scopeKey(FATWA, "en")).not.toBe(scopeKey({ mode: "fatwa", context: { ...FATWA.context, sha256: "x" } }, "en"));
    expect(scopeKey(FATWA, "en")).not.toBe(scopeKey({ mode: "fatwa", context: { ...FATWA.context, version: "v3" } }, "en"));
    expect(scopeKey(QURAN, "en")).not.toBe(scopeKey({ mode: "quran", context: { ...QURAN.context, ayah: 32 } }, "en"));
    expect(scopeKey(QURAN, "en")).not.toBe(scopeKey({ mode: "quran", context: { ...QURAN.context, tafsir: true } }, "en"));
    expect(scopeKey(SITE, "ar")).not.toBe(scopeKey(SITE, "en"));
  });

  it("a reply applies only to the same request id, scope key and locale", () => {
    const body = buildAskBody(FATWA, "en", "q");
    const ticket = ticketFor(body, FATWA);
    const key = scopeKey(FATWA, "en");
    expect(replyApplies({ request_id: body.request_id }, ticket, ticket, key, "en")).toBe(true);
    expect(replyApplies({ request_id: "other" }, ticket, ticket, key, "en")).toBe(false);
    expect(replyApplies({ request_id: body.request_id }, ticket, null, key, "en")).toBe(false);
    expect(replyApplies({ request_id: body.request_id }, ticket, { ...ticket, requestId: "newer" }, key, "en")).toBe(false);
    expect(replyApplies({ request_id: body.request_id }, ticket, ticket, scopeKey(SITE, "en"), "en")).toBe(false);
    expect(replyApplies({ request_id: body.request_id }, ticket, ticket, key, "ar")).toBe(false);
    expect(stillApplies(ticket, ticket, key, "en")).toBe(true);
    expect(stillApplies(ticket, ticket, null, "en")).toBe(false);
  });
});

describe("askAssistant", () => {
  it("posts JSON once and returns the reply", async () => {
    const body = buildAskBody(SITE, "ar", "help");
    const reply = { request_id: body.request_id, status: "answered", paragraphs: [], evidence: [] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(reply), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(askAssistant(body)).resolves.toMatchObject({ request_id: body.request_id });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/assistant/ask");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(body);
  });

  it("throws a typed error with code, message, retryable and status", async () => {
    const body = buildAskBody(SITE, "ar", "help");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: { code: "not_configured", message: "off", retryable: false } }), { status: 503 })),
    );
    const err = await askAssistant(body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AssistantError);
    expect(err).toMatchObject({ status: 503, code: "not_configured", message: "off", retryable: false });
  });

  it("maps FastAPI validation errors and mismatched reply ids", async () => {
    const body = buildAskBody(SITE, "ar", "help");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: [{ loc: ["body", "question"], msg: "too long" }] }), { status: 422 })),
    );
    await expect(askAssistant(body)).rejects.toMatchObject({ status: 422, code: "validation", details: ["question: too long"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ request_id: "other", status: "answered", paragraphs: [], evidence: [] }), { status: 200 })),
    );
    await expect(askAssistant(body)).rejects.toMatchObject({ code: "invalid_reply" });
  });

  it("passes the abort signal to fetch", async () => {
    const body = buildAskBody(SITE, "ar", "help");
    const ctrl = new AbortController();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = askAssistant(body, ctrl.signal);
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("resolveScope", () => {
  const quran = {
    mode: "quran" as const,
    title: "النبأ",
    locale: "en",
    href: "/library/quran/78?lang=en",
    edition: "Saheeh International",
    tafsir: true,
    ayahCount: 40,
    route: { surah: 78, name: "النبأ", sha256: SHA, version: "english_saheeh.v1" },
    focus: null,
  };

  it("uses the reader focus, else the picked ayah of the route surah, never beyond its ayah count", () => {
    expect(resolveScope(null, 1)).toEqual({ mode: "site_help", context: null });
    expect(resolveScope(quran, 31)).toEqual({ mode: "quran", context: { surah: 78, ayah: 31, sha256: SHA, version: "english_saheeh.v1", tafsir: true } });
    expect(resolveScope(quran, 99)?.context).toMatchObject({ ayah: 40 });
    expect(resolveScope(quran, 0)?.context).toMatchObject({ ayah: 1 });
    const focus = { surah: 79, ayah: 2, name: "النازعات", sha256: "sha256:f", version: "english_saheeh.v1" };
    expect(resolveScope({ ...quran, focus }, 31)?.context).toMatchObject({ surah: 79, ayah: 2, sha256: "sha256:f" });
    expect(resolveScope({ ...quran, focus: { ...focus, sha256: null } }, 31)).toBeNull();
  });

  it("passes record context through unchanged", () => {
    const ctx = { record_id: "hadeethenc-65000", sha256: SHA, version: "balligh.library.hadith/2" };
    expect(resolveScope({ mode: "hadith", title: "t", locale: "en", href: "/x", context: ctx }, 1)).toEqual({ mode: "hadith", context: ctx });
  });
});
