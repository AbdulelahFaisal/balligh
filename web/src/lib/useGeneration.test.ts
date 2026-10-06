import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { forCurrentOptions, optionKey, type GenerationOptions, type GenerationState } from "./useGeneration";

const shown: GenerationOptions = {
  sourceId: "src-a",
  sourceVersion: "v1",
  sourceSha256: "a".repeat(64),
  locale: "en",
  level: "foundational",
};

const changes: Record<string, GenerationOptions> = {
  source: { ...shown, sourceId: "src-b" },
  version: { ...shown, sourceVersion: "v2" },
  hash: { ...shown, sourceSha256: "b".repeat(64) },
  locale: { ...shown, locale: "fr" },
  level: { ...shown, level: "detailed" },
};

describe("a confirmation or retry belongs to the options it was opened with", () => {
  const waiting: GenerationState[] = [
    { phase: "confirm", options: shown },
    { phase: "failed", options: shown, error: new ApiError("x", 502, [], "invalid_output", true) },
  ];

  it.each(Object.entries(changes))("a %s change closes it", (_, changed) => {
    for (const state of waiting) expect(forCurrentOptions(state, optionKey(changed))).toEqual({ phase: "idle" });
  });

  it("unchanged options keep it, and a running request is never touched", () => {
    for (const state of waiting) expect(forCurrentOptions(state, optionKey({ ...shown }))).toBe(state);
    const running: GenerationState = { phase: "running", options: shown, startedAt: 1 };
    expect(forCurrentOptions(running, optionKey(changes.locale))).toBe(running);
    expect(forCurrentOptions(waiting[0], null)).toEqual({ phase: "idle" });
  });
});
