import { describe, expect, it } from "vitest";
import fixtureJson from "../../../content/examples/g1-citation-lesson-en.json";
import { markHumanEdit } from "./provenance";
import { emptyFields, semanticKey } from "./semantic";
import type { LessonDraft } from "./types";

const fixture = fixtureJson as unknown as LessonDraft;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversedKeys(v)]));
  return value;
}

describe("semanticKey", () => {
  it("ignores font size, provenance timestamps and key order", () => {
    const base = semanticKey(fixture);
    const scaled = clone(fixture);
    scaled.presentation.font_scale = 1.5;
    expect(semanticKey(scaled)).toBe(base);
    expect(semanticKey(markHumanEdit(clone(fixture), "2026-10-06T04:00:00Z"))).toBe(base);
    expect(semanticKey(reversedKeys(clone(fixture)) as LessonDraft)).toBe(base);
  });

  it.each([
    ["term display", (d: LessonDraft) => (d.terms[0].display_form = "citation")],
    ["term meaning", (d: LessonDraft) => (d.terms[0].meaning = "Another meaning.")],
    ["option text", (d: LessonDraft) => (d.activity.options[0].text = "Publish it later.")],
    ["correct option", (d: LessonDraft) => (d.activity.correct_option_id = "a")],
    ["rationale", (d: LessonDraft) => (d.activity.rationale = "Another reason.")],
    ["editor note", (d: LessonDraft) => (d.cards[0].editor_note = "x")],
    ["lesson id", (d: LessonDraft) => (d.id = "another-lesson")],
  ])("changes when the %s changes", (_name, edit) => {
    const changed = clone(fixture);
    edit(changed);
    expect(semanticKey(changed)).not.toBe(semanticKey(fixture));
  });
});

describe("emptyFields", () => {
  it("reports blank editable fields by path and nothing for a complete lesson", () => {
    expect(emptyFields(fixture).size).toBe(0);
    const d = clone(fixture);
    d.terms[1].meaning = "  ";
    d.activity.options[2].text = "";
    d.activity.rationale = "\n";
    expect([...emptyFields(d)].sort()).toEqual(
      [`term:${d.terms[1].term_id}:meaning`, "activity:rationale", `option:${d.activity.options[2].id}:text`].sort(),
    );
  });
});
