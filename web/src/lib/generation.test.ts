import { describe, expect, it } from "vitest";
import fixtureJson from "../../../content/examples/g1-citation-lesson-en.json";
import { canApplyResult, isLive, markHumanEdit } from "./provenance";
import { highlightSegments } from "./spans";
import { parseSaved } from "./storage";
import type { LessonDraft, LiveGeneration } from "./types";

const fixture = fixtureJson as unknown as LessonDraft;

const live: LiveGeneration = {
  origin: "live",
  provider: "deepseek",
  requested_model: "deepseek-v4-pro",
  returned_model: "deepseek-v4-pro",
  prompt_version: "g2-lesson-1",
  request_id: "11111111-2222-4333-8444-555555555555",
  generated_at: "2026-10-06T02:00:00+03:00",
  source_sha256: "a".repeat(64),
  glossary_sha256: "b".repeat(64),
  settings: { thinking: "enabled", reasoning_effort: "high", response_format: "json_object", max_tokens: 16384 },
  usage: {
    prompt_tokens: 1800,
    completion_tokens: 2500,
    total_tokens: 4300,
    prompt_cache_hit_tokens: null,
    prompt_cache_miss_tokens: null,
    reasoning_tokens: 2100,
  },
  latency_ms: 45000,
  note: "",
  human_edited: false,
  last_human_edit_at: null,
};
const liveDraft: LessonDraft = { ...fixture, generation: live };

describe("highlightSegments uses code points like the server", () => {
  it("keeps offsets aligned with combining marks and astral characters", () => {
    const text = "قَالَ الكاتبُ 𝔸 كلمةً. ثُمَّ سكتَ؟ وانتهى 😀";
    expect(text.length).toBeGreaterThan(Array.from(text).length);
    const firstEnd = Array.from("قَالَ الكاتبُ 𝔸 كلمةً.").length;
    const secondStart = Array.from(text).indexOf("ث");
    const parts = highlightSegments(text, [
      { id: "s1", start: 0, end: firstEnd },
      { id: "s2", start: secondStart, end: secondStart + Array.from("ثُمَّ سكتَ؟").length },
    ]);
    expect(parts.map((p) => [p.id, p.text])).toEqual([
      ["s1", "قَالَ الكاتبُ 𝔸 كلمةً."],
      [null, " "],
      ["s2", "ثُمَّ سكتَ؟"],
      [null, " وانتهى 😀"],
    ]);
    expect(parts.map((p) => p.text).join("")).toBe(text);
  });
});

describe("markHumanEdit keeps the original provenance", () => {
  it("records a human edit on a live draft without changing its model record", () => {
    const edited = markHumanEdit(liveDraft, "2026-10-06T03:00:00+03:00");
    expect(isLive(edited.generation)).toBe(true);
    expect(edited.generation).toMatchObject({
      origin: "live",
      request_id: live.request_id,
      requested_model: "deepseek-v4-pro",
      usage: live.usage,
      human_edited: true,
      last_human_edit_at: "2026-10-06T03:00:00+03:00",
    });
    expect(liveDraft.generation.human_edited).toBe(false);
  });

  it("keeps a fixture a fixture instead of relabelling it", () => {
    const edited = markHumanEdit(fixture, "2026-10-06T03:00:00+03:00");
    expect(edited.generation.origin).toBe("fixture");
    expect(edited.generation.human_edited).toBe(true);
  });
});

describe("canApplyResult", () => {
  const ticket = { opId: 3, revision: 10 };
  it("applies only the current, unaborted operation on an unchanged workspace", () => {
    expect(canApplyResult(ticket, 3, 10, false)).toBe(true);
    expect(canApplyResult(ticket, 4, 10, false)).toBe(false);
    expect(canApplyResult(ticket, 3, 11, false)).toBe(false);
    expect(canApplyResult(ticket, 3, 10, true)).toBe(false);
  });
});

describe("stored live drafts", () => {
  const raw = (draft: unknown) => JSON.stringify({ version: 1, draft, review: null });

  it("accepts live metadata and old fixture drafts without the new fields", () => {
    expect(parseSaved(raw(liveDraft)).kind).toBe("ok");
    expect(parseSaved(raw({ ...liveDraft, generation: { ...live, usage: null, returned_model: null } })).kind).toBe("ok");
    expect(parseSaved(raw({ ...fixture, generation: { origin: "manual", note: "Edited by hand after the G1 fixture." } })).kind).toBe("ok");
  });

  it.each([
    ["usage counts are strings", { ...live, usage: { ...live.usage, prompt_tokens: "many" } }],
    ["request id is an object", { ...live, request_id: {} }],
    ["human_edited is missing", { ...live, human_edited: undefined }],
    ["unknown origin", { ...live, origin: "imported" }],
    ["note is an object", { ...live, note: { x: 1 } }],
  ])("rejects malformed live metadata: %s", (_name, generation) => {
    expect(parseSaved(raw({ ...liveDraft, generation }))).toMatchObject({ kind: "unreadable", reason: "invalid_structure" });
  });
});
