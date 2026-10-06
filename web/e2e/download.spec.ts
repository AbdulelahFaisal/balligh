import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/review/G1-P1/downloads");

test("export buttons produce real browser downloads that open and re-import", async ({ page, context }, info) => {
  mkdirSync(OUT, { recursive: true });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/");
  await page.getByRole("button", { name: "جرّب درسًا" }).click();
  await expect(page.getByTestId("lesson")).toBeVisible();

  const [htmlDl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "صدّر HTML" }).click()]);
  expect(await htmlDl.failure(), "HTML download failed in the browser").toBeNull();
  const htmlPath = `${OUT}/${info.project.name}-${htmlDl.suggestedFilename()}`;
  await htmlDl.saveAs(htmlPath);
  expect(readFileSync(htmlPath).length).toBeGreaterThan(0);

  const [jsonDl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "صدّر JSON" }).click()]);
  expect(await jsonDl.failure(), "JSON download failed in the browser").toBeNull();
  const jsonPath = `${OUT}/${info.project.name}-${jsonDl.suggestedFilename()}`;
  await jsonDl.saveAs(jsonPath);
  expect(readFileSync(jsonPath).length).toBeGreaterThan(0);

  const offline = await context.newPage();
  await offline.goto(pathToFileURL(htmlPath).href);
  await expect(offline.locator("h1")).toContainText("Test lesson");
  expect(await offline.locator("script, img, iframe").count()).toBe(0);
  await offline.close();

  await page.getByRole("button", { name: "امسح العمل المحلي" }).click();
  await page.getByTestId("import-input").setInputFiles(jsonPath);
  await expect(page).toHaveURL(/\/review$/);
  await expect.poll(() => page.getByTestId("review-status").first().getAttribute("data-status")).toBe("draft");
});
