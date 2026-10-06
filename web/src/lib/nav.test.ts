import { describe, expect, it } from "vitest";
import { PRIMARY_NAV, TEACHER_STEPS } from "@/App";

const activeFor = (path: string) => PRIMARY_NAV.filter((n) => n.match(path)).map((n) => n.to);

describe("primary navigation", () => {
  it("has exactly three destinations: Learn, Library, Prepare a lesson", () => {
    expect(PRIMARY_NAV.map((n) => n.key)).toEqual(["learn.nav.learn", "learn.nav.library", "learn.nav.prepare"]);
  });

  it("keeps setup, review and preview as steps of one teacher destination", () => {
    expect(TEACHER_STEPS.map((s) => s.to)).toEqual(["/setup", "/review", "/preview"]);
    for (const s of TEACHER_STEPS) expect(activeFor(s.to)).toEqual(["/setup"]);
  });

  it("marks one destination for library deep links and none for secondary pages", () => {
    expect(activeFor("/library/questions/binbaz-2171")).toEqual(["/library"]);
    expect(activeFor("/library/quran/78")).toEqual(["/library"]);
    expect(activeFor("/learn")).toEqual(["/learn"]);
    expect(activeFor("/sources")).toEqual([]);
    expect(activeFor("/")).toEqual([]);
    expect(activeFor("/libraryx")).toEqual([]);
  });
});
