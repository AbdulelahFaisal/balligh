import { expect, test } from "@playwright/test";

test.describe("download control", () => {
  for (const [name, href] of [
    ["data-url", "data:text/plain;charset=utf-8,hello"],
    ["blob-url", "BLOB"],
  ] as const) {
    test(`minimal ${name} download`, async ({ page }) => {
      await page.goto("/sources");
      await page.evaluate((h) => {
        const a = document.createElement("a");
        a.href = h === "BLOB" ? URL.createObjectURL(new Blob(["hello"], { type: "text/plain" })) : h;
        a.download = "control.txt";
        a.id = "control";
        a.textContent = "control";
        document.body.appendChild(a);
      }, href);
      const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#control")]);
      const failure = await dl.failure();
      console.log(`CONTROL ${name}: failure=${failure}`);
      expect(failure).toBeNull();
    });
  }
});
