import { describe, expect, it } from "vitest";
import { safeSourceUrl } from "./safeUrl";

describe("safeSourceUrl", () => {
  it("accepts https registry hosts", () => {
    expect(safeSourceUrl("https://dorar.net/hadith/1")).toBe("https://dorar.net/hadith/1");
    expect(safeSourceUrl("https://www.binbaz.org.sa/fatwas/1")).not.toBeNull();
  });
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://dorar.net/",
    "https://evil.example/",
    "https://dorar.net.evil.example/",
    "https://user:pw@dorar.net/",
    "https://dorar.net:8443/",
    " https://dorar.net/",
    "",
  ])("rejects %s", (u) => {
    expect(safeSourceUrl(u)).toBeNull();
  });
});
