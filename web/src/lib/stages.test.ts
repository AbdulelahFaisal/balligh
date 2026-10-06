import { describe, expect, it } from "vitest";
import { COMPLETION_KEY, distinctKeys, entryKey, isStagePath, loadCompletion, saveCompletion, type StagePath } from "./stages";

const sha = (c: string) => c.repeat(64);

const path: StagePath = {
  schema: "balligh.learn.stages.v1",
  version: "2026-10-06.1",
  path_id: "introductory-reading",
  identity: sha("a"),
  entry_count: 3,
  distinct_count: 2,
  stages: [
    { order: 1, key: "introduction_belief", entries: [{ collection: "quran", source_id: "112", recap: false, title: "الإخلاص", languages: ["ar"], content_sha256: sha("b"), href: "/library/quran/112" }] },
    {
      order: 2,
      key: "testimony_pillars",
      entries: [
        { collection: "hadith", source_id: "hadeethenc-65000", recap: false, title: "بني الإسلام على خمس", languages: ["ar", "en"], content_sha256: sha("c"), href: "/library/hadith/hadeethenc-65000" },
        { collection: "hadith", source_id: "hadeethenc-65000", recap: true, title: "بني الإسلام على خمس", languages: ["ar", "en"], content_sha256: sha("c"), href: "/library/hadith/hadeethenc-65000" },
      ],
    },
  ],
  not_covered: ["prayer_demonstration"],
  human_support: { name: "eDialogue", operator_ar: "جمعية ركن الحوار", url: "https://edialogue.org/", faq_url: "https://edialogue.org/faq/" },
};

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe("stage path completion", () => {
  it("validates the stage path shape and the eDialogue destination", () => {
    expect(isStagePath(path)).toBe(true);
    expect(isStagePath({ ...path, human_support: { ...path.human_support, url: "https://edialoguec.org.sa/programs/5" } })).toBe(false);
  });

  it("counts a recap as the same reading", () => {
    expect(distinctKeys(path)).toHaveLength(2);
  });

  it("saves explicit marks bound to the path version and identity, in its own key only", () => {
    const s = memory();
    const key = entryKey(path.stages[0].entries[0]);
    expect(saveCompletion(s, path, [key])).toBe("saved");
    expect([...s.data.keys()]).toEqual([COMPLETION_KEY]);
    const saved = JSON.parse(s.data.get(COMPLETION_KEY)!);
    expect(saved.version).toBe(path.version);
    expect(saved.identity).toBe(path.identity);
    expect(loadCompletion(s, path)).toEqual({ kind: "ok", done: [key] });
  });

  it("does not reuse marks from another path identity and does not overwrite them silently", () => {
    const s = memory();
    saveCompletion(s, path, [entryKey(path.stages[0].entries[0])]);
    const changed = { ...path, identity: sha("d") };
    expect(loadCompletion(s, changed)).toEqual({ kind: "outdated" });
    expect(saveCompletion(s, changed, [])).toBe("malformed");
    expect(saveCompletion(s, changed, [], true)).toBe("saved");
  });

  it("reports malformed, unavailable and failed writes honestly", () => {
    const bad = memory({ [COMPLETION_KEY]: "{not json" });
    expect(loadCompletion(bad, path)).toEqual({ kind: "malformed" });
    expect(saveCompletion(bad, path, [])).toBe("malformed");
    expect(bad.data.get(COMPLETION_KEY)).toBe("{not json");
    expect(loadCompletion(null, path)).toEqual({ kind: "unavailable" });
    const failing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    expect(saveCompletion(failing, path, [])).toBe("write_failed");
  });
});
