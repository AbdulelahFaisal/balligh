import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../../docs/review/G5-B/screenshots");
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, project: string, name: string) =>
  page.screenshot({ path: `${SHOTS}/${project}-G5B-learn-${name}.png`, fullPage: false });
const COMPLETION_KEY = "balligh.learn-completion.v1";
const ctx = (stage: number | string, entry: number | string) => `path=introductory-reading&stage=${stage}&entry=${entry}`;

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
});

test("the five-stage path is the single Learn journey with one primary Start action", async ({ page }, info) => {
  await page.goto("/learn");
  await expect(page.getByTestId("stage-path")).toBeVisible();
  await expect(page.getByTestId("first-steps")).toHaveCount(0);
  await expect(page.getByTestId("first-step")).toHaveCount(0);
  await expect(page.getByTestId("start-first-step")).toHaveCount(0);
  await expect(page.getByTestId("stage-start-link")).toHaveCount(1);
  await expect(page.getByTestId("stage-start")).toHaveAttribute("data-state", "start");
  await expect(page.getByTestId("stage-start")).toHaveAttribute("data-id", "112");
  await expect(page.getByTestId("stage-start-link")).toHaveAttribute("href", `/library/quran/112?lang=ar&${ctx(1, 1)}`);
  await shot(page, info.project.name, "start");

  // Continue follows explicit marks only, in stage order.
  await page.getByTestId("stage-entry").first().getByTestId("mark-read").click();
  await expect(page.getByTestId("stage-start")).toHaveAttribute("data-state", "continue");
  await expect(page.getByTestId("stage-start")).toHaveAttribute("data-id", "binbaz-11423");
  await expect(page.getByTestId("stage-start-link")).toHaveAttribute("href", `/library/questions/binbaz-11423?lang=ar&${ctx(1, 2)}`);
  await page.getByTestId("stage-entry").first().getByTestId("mark-read").click();
  await expect(page.getByTestId("stage-start")).toHaveAttribute("data-state", "start");
  await expect(page.getByTestId("stage-start")).toHaveAttribute("data-id", "112");
});

test("stage 1: Quran 112, Next binbaz-11423, Next hadeethenc-65050, then Back to stage 1; visiting never marks", async ({ page }, info) => {
  await page.goto("/learn");
  await page.getByTestId("stage-start-link").click();
  await expect(page).toHaveURL(new RegExp(`/library/quran/112\\?lang=ar&${ctx(1, 1)}$`));
  const bar = page.getByTestId("stage-bar");
  await expect(bar).toHaveAttribute("data-stage", "1");
  await expect(page.getByTestId("back-to-stage")).toHaveText("العودة إلى المرحلة 1");
  await expect(page.getByTestId("stage-next-link")).toHaveAttribute("data-id", "binbaz-11423");
  await page.getByTestId("stage-next-link").click();
  await expect(page).toHaveURL(new RegExp(`/library/questions/binbaz-11423\\?lang=ar&${ctx(1, 2)}$`));
  await expect(page.getByTestId("item-title")).toBeVisible();
  await expect(page.getByTestId("stage-position")).toContainText("2 من 3");
  await expect(page.getByTestId("stage-next-link")).toHaveAttribute("data-id", "hadeethenc-65050");
  await page.getByTestId("stage-next-link").click();
  await expect(page).toHaveURL(new RegExp(`/library/hadith/hadeethenc-65050\\?lang=ar&${ctx(1, 3)}$`));
  await expect(page.getByTestId("item-title")).toBeVisible();
  await expect(page.getByTestId("stage-next-link")).toHaveAttribute("data-id", "binbaz-18975");
  await expect(page.getByTestId("stage-next-link")).toHaveAttribute("data-stage", "2");
  await shot(page, info.project.name, "reader-bar");
  expect(await page.evaluate((k) => localStorage.getItem(k), COMPLETION_KEY)).toBeNull();
  await page.getByTestId("back-to-stage").click();
  await expect(page).toHaveURL(/\/learn\?stage=1$/);
  await expect(page.getByTestId("stage-panel")).toHaveAttribute("data-stage", "1");
  await expect(page.locator('[data-testid="stage-entry"][data-read="true"]')).toHaveCount(0);
});

test("hadeethenc-65000 resolves by stage and entry: stage 2 and the stage-4 recap have different Next", async ({ page }) => {
  await page.goto(`/library/hadith/hadeethenc-65000?lang=ar&${ctx(2, 2)}`);
  await expect(page.getByTestId("stage-bar")).toHaveAttribute("data-stage", "2");
  await expect(page.getByTestId("stage-next-link")).toHaveAttribute("data-id", "binbaz-3982");
  await expect(page.getByTestId("back-to-stage")).toHaveAttribute("href", "/learn?stage=2");
  await page.goto(`/library/hadith/hadeethenc-65000?lang=ar&${ctx(4, 1)}`);
  await expect(page.getByTestId("stage-bar")).toHaveAttribute("data-stage", "4");
  await expect(page.getByTestId("stage-next-link")).toHaveAttribute("data-id", "hadeethenc-4196");
  await expect(page.getByTestId("back-to-stage")).toHaveAttribute("href", "/learn?stage=4");
  await page.goto("/learn?stage=4");
  const recap = page.locator('[data-testid="stage-entry"][data-recap="true"]');
  await expect(recap.getByTestId("stage-entry-link")).toHaveAttribute("href", `/library/hadith/hadeethenc-65000?lang=ar&${ctx(4, 1)}`);
  // The last entry of the last stage leads to the end section, not to an unrelated text.
  await page.goto(`/library/questions/binbaz-854?lang=ar&${ctx(5, 3)}`);
  await expect(page.getByTestId("stage-end-link")).toHaveAttribute("href", "/learn?stage=end");
  await expect(page.getByTestId("stage-next-link")).toHaveCount(0);
});

test("direct library browsing and invalid context show no course Next", async ({ page }) => {
  await page.goto(`/library/questions/binbaz-11423?lang=ar&${ctx(1, 2)}`);
  await expect(page.getByTestId("stage-bar")).toBeVisible();
  const bad = [
    "",
    "path=other&stage=1&entry=2",
    ctx("1.5", 2),
    ctx(1, "2.0"),
    ctx(0, 2),
    ctx(9, 2),
    ctx(1, 0),
    ctx(1, 4),
    ctx(1, 1),
    ctx("1e0", 2),
    ctx(" 1", 2),
    ctx(-1, 2),
  ];
  for (const q of bad) {
    await page.goto(`/library/questions/binbaz-11423?lang=ar${q ? `&${q}` : ""}`);
    await expect(page.getByTestId("item-title")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("stage-bar"), q).toHaveCount(0);
    await expect(page.getByTestId("stage-next-link")).toHaveCount(0);
  }
  await page.goto("/library/hadith/hadeethenc-65000");
  await expect(page.getByTestId("item-title")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("stage-bar")).toHaveCount(0);
});

test("the selected reading language is carried into stage links and kept by Next", async ({ page }) => {
  await page.goto("/learn");
  await page.locator("header select").selectOption("en");
  await expect(page.getByTestId("stage-start-link")).toHaveAttribute("href", `/library/quran/112?lang=en&${ctx(1, 1)}`);
  await expect(page.getByTestId("stage-entry-link").nth(2)).toHaveAttribute("href", `/library/hadith/hadeethenc-65050?lang=en&${ctx(1, 3)}`);
  await page.goto(`/library/questions/binbaz-11423?lang=fr&${ctx(1, 2)}`);
  await expect(page.getByTestId("stage-next-link")).toHaveAttribute("href", `/library/hadith/hadeethenc-65050?lang=fr&${ctx(1, 3)}`);
});
