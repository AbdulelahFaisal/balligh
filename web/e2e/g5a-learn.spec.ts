import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../../docs/review/G5-A/learn");
mkdirSync(SHOTS, { recursive: true });

const shot = (page: Page, project: string, name: string) =>
  page.screenshot({ path: `${SHOTS}/${project}-G5A-${name}.png`, fullPage: false });
const KEY = "balligh.learn-completion.v1";
const FLAGGED = [15, 1614, 2002, 2348, 2631, 2778, 3442, 3446, 3709, 5627, 6782, 9614, 1157, 1263, 1998, 2171, 2554, 5629, 11643].map((n) => `binbaz-${n}`);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
});

test("five stages stay open, Next moves forward, and the just-exploring entry leads to the first reading", async ({ page }, info) => {
  const api = await (await page.request.get("/api/learn/stages")).json();
  expect(api.entry_count).toBe(17);
  expect(api.distinct_count).toBe(16);
  await page.goto("/learn");
  await expect(page.getByTestId("stage-start-link")).toBeVisible();
  await expect(page.getByTestId("first-step")).toHaveCount(0);
  await expect(page.getByTestId("stage-tab")).toHaveCount(6);
  await expect(page.getByTestId("stage-panel")).toHaveAttribute("data-stage", "1");
  await expect(page.getByTestId("stage-entry")).toHaveCount(3);
  await shot(page, info.project.name, "stage1");
  await page.getByTestId("stage-tab").nth(4).click();
  await expect(page.getByTestId("stage-panel")).toHaveAttribute("data-stage", "5");
  await expect(page.locator("#stage-heading")).toBeFocused();
  await page.getByTestId("stage-tab").nth(2).click();
  await expect(page.getByTestId("stage-entry")).toHaveCount(4);
  await page.getByTestId("next-stage").click();
  await expect(page.getByTestId("stage-panel")).toHaveAttribute("data-stage", "4");
  const recap = page.locator('[data-testid="stage-entry"][data-recap="true"]');
  await expect(recap).toHaveCount(1);
  await expect(recap).toHaveAttribute("data-id", "hadeethenc-65000");
  await expect(recap.getByTestId("recap-badge")).toBeVisible();
  let total = 0;
  for (let n = 1; n <= 5; n++) {
    await page.getByTestId("stage-tab").nth(n - 1).click();
    await expect(page.getByTestId("stage-panel")).toHaveAttribute("data-stage", String(n));
    total += await page.getByTestId("stage-entry").count();
  }
  expect(total).toBe(17);
  await page.goto("/learn");
  await expect(page.getByTestId("just-exploring")).toHaveAttribute("href", "/library/quran/112");
  await page.getByTestId("just-exploring").click();
  await expect(page).toHaveURL(/\/library\/quran\/112$/);
});

test("reading completion is an explicit action, persists in its own key, and opening a text does not mark it", async ({ page }) => {
  await page.goto("/learn");
  const first = page.getByTestId("stage-entry").first();
  await first.getByTestId("stage-entry-link").click();
  await page.goBack();
  await expect(page.getByTestId("completion-progress")).toContainText("0");
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull();
  const protectedKeys = () => page.evaluate(() => ["balligh.workspace.v1", "balligh.progress.v1", "balligh.reading.v1"].map((k) => localStorage.getItem(k)));
  const before = await protectedKeys();
  await page.getByTestId("stage-entry").first().getByTestId("mark-read").click();
  await expect(page.getByTestId("stage-entry").first().getByTestId("mark-read")).toHaveAttribute("aria-pressed", "true");
  const saved = JSON.parse((await page.evaluate((k) => localStorage.getItem(k), KEY)) ?? "{}");
  expect(saved.schema).toBe("balligh.learn-completion/1");
  expect(saved.version).toBe("2026-10-06.1");
  expect(saved.identity).toMatch(/^[0-9a-f]{64}$/);
  expect(saved.done).toHaveLength(1);
  expect(await protectedKeys()).toEqual(before);
  await page.reload();
  await expect(page.getByTestId("stage-entry").first().getByTestId("mark-read")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("stage-tab").nth(1).click();
  await page.locator('[data-testid="stage-entry"][data-id="hadeethenc-65000"]').getByTestId("mark-read").click();
  await page.getByTestId("stage-tab").nth(3).click();
  await expect(page.locator('[data-testid="stage-entry"][data-recap="true"]')).toHaveAttribute("data-read", "true");
});

test("storage failures are shown honestly and malformed marks are left unchanged", async ({ page }, info) => {
  await page.evaluate((k) => localStorage.setItem(k, "{broken"), KEY);
  await page.goto("/learn");
  await expect(page.getByTestId("completion-notice")).toHaveAttribute("data-notice", "malformed");
  await page.getByTestId("stage-entry").first().getByTestId("mark-read").click();
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe("{broken");
  await page.evaluate(() => localStorage.clear());
  await page.addInitScript((k) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === k) throw new DOMException("full", "QuotaExceededError");
      return original.call(this, key, value);
    };
  }, KEY);
  await page.goto("/learn");
  await page.getByTestId("stage-entry").first().getByTestId("mark-read").click();
  await expect(page.getByTestId("completion-notice")).toHaveAttribute("data-notice", "write_failed");
  await shot(page, info.project.name, "write-failed");
});

test("the end states introductory reading, lists what is not covered, and offers one plain eDialogue link", async ({ page }, info) => {
  await page.goto("/learn?stage=end");
  await expect(page.getByTestId("end-summary")).toHaveAttribute("data-complete", "false");
  await expect(page.getByTestId("not-covered").locator("li")).toHaveCount(4);
  const link = page.getByTestId("human-support-link");
  await expect(link).toHaveAttribute("href", "https://edialogue.org/");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(page.locator('a[href*="edialogue"]')).toHaveCount(1);
  await expect(page.locator('a[href*="edialoguec.org.sa"]')).toHaveCount(0);
  await expect(page.getByTestId("human-support-faq")).toContainText("https://edialogue.org/faq/");
  await expect(page.getByTestId("human-support")).toContainText("جمعية ركن الحوار");
  await shot(page, info.project.name, "end-partial");
  for (let n = 1; n <= 5; n++) {
    await page.getByTestId("stage-tab").nth(n - 1).click();
    await expect(page.getByTestId("stage-panel")).toHaveAttribute("data-stage", String(n));
    const buttons = page.locator('[data-testid="stage-entry"][data-read="false"] [data-testid="mark-read"]');
    while ((await buttons.count()) > 0) await buttons.first().click();
  }
  await page.getByTestId("stage-tab").nth(5).click();
  await expect(page.getByTestId("end-summary")).toHaveAttribute("data-complete", "true");
  await shot(page, info.project.name, "end-complete");
});

test("flagged teacher-context fatwas are not presented as beginner recommendations in Learn", async ({ page }) => {
  await page.goto("/learn");
  await expect(page.getByTestId("stage-entry").first()).toBeVisible();
  for (let n = 1; n <= 5; n++) {
    await page.getByTestId("stage-tab").nth(n - 1).click();
    await expect(page.getByTestId("stage-panel")).toHaveAttribute("data-stage", String(n));
    const ids = await page.getByTestId("stage-entry").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
    expect(ids.filter((id) => FLAGGED.includes(id ?? ""))).toEqual([]);
  }
  const steps = await page.getByTestId("first-step").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
  expect(steps.filter((id) => FLAGGED.includes(id ?? ""))).toEqual([]);
});
