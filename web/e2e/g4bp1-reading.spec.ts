import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../../docs/review/G4-B-P2/reading");
mkdirSync(SHOTS, { recursive: true });

const READING_KEY = "balligh.reading.v1";
const FATWA = "/library/questions/binbaz-2171";
const HADITH = "/library/hadith/hadeethenc-2945";
const shot = (page: Page, project: string, name: string) =>
  page.screenshot({ path: `${SHOTS}/${project}-${name}.png`, fullPage: false });
const stored = (page: Page) => page.evaluate((k) => localStorage.getItem(k), READING_KEY);
const otherKeys = (page: Page) =>
  page.evaluate(() => Object.fromEntries(["balligh.lesson.v1", "balligh.teacher.context.v1"].map((x) => [x, localStorage.getItem(x)])));
const noPlayback = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll("audio,video")].every((m) => (m as HTMLMediaElement).paused));

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("balligh.teacher.context.v1", "TEACHER-BYTES");
    localStorage.setItem("balligh.lesson.v1", "LESSON-BYTES");
  });
});

test("fatwa answer: explicit save survives reload and Continue restores it visible and focused after a held fetch", async ({ page }, info) => {
  await page.goto(FATWA);
  await expect(page.getByTestId("item-title")).toBeVisible();
  const auto = JSON.parse((await stored(page)) ?? "null");
  expect(auto?.last?.anchor).toBe("fatwa-question");
  const save = page.getByTestId("reader-save").getByTestId("save-place");
  await page.locator("#fatwa-answer").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(save).toHaveAttribute("data-anchor", "fatwa-answer");
  await expect(save).toHaveText("احفظ موضعي هنا");
  await save.click();
  await expect(page.getByTestId("reader-save").getByTestId("save-place-status")).toHaveText("حُفظ موضعك هنا.");
  expect(JSON.parse((await stored(page))!).last.anchor).toBe("fatwa-answer");
  await page.reload();
  await expect(page.getByTestId("item-title")).toBeVisible();
  await expect(page.locator("#fatwa-answer")).toBeVisible();
  expect(JSON.parse((await stored(page))!).last.anchor).toBe("fatwa-answer");
  const bytes = await stored(page);

  await page.goto("/learn");
  const link = page.getByTestId("continue-link");
  await expect(link).toHaveAttribute("href", /binbaz-2171\?lang=ar#fatwa-answer$/);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/library/fatwas/binbaz-2171*", async (route) => {
    await held;
    await route.continue();
  });
  await link.click();
  await expect(page.getByTestId("fatwa-reader")).toBeVisible();
  await expect(page.locator("#fatwa-answer")).toHaveCount(0);
  release();
  const target = page.locator("#fatwa-answer");
  await expect(target).toBeInViewport();
  await expect(target).toBeFocused();
  await expect(page.locator("#fatwa-answer:focus")).toHaveCount(1);
  await expect(page.getByTestId("restore-fallback")).toHaveCount(0);
  expect(await stored(page)).toBe(bytes);
  expect(await noPlayback(page)).toBe(true);
  await shot(page, info.project.name, "fatwa-continue");
  expect(await otherKeys(page)).toEqual({ "balligh.lesson.v1": "LESSON-BYTES", "balligh.teacher.context.v1": "TEACHER-BYTES" });
});

test("hadith explanation well below the fold: save, Continue, reduced motion; stale and bad anchors fall back truthfully", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(HADITH);
  await expect(page.getByTestId("item-title")).toBeVisible();
  const target = page.locator("#hadith-explanation");
  await expect(target).toBeVisible();
  await expect(target).not.toBeInViewport();
  const save = page.getByTestId("reader-save").getByTestId("save-place");
  await page.locator("#hadith-explanation").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(save).toHaveAttribute("data-anchor", "hadith-explanation");
  await save.click();
  await expect(page.getByTestId("reader-save").getByTestId("save-place-status")).toHaveText("حُفظ موضعك هنا.");
  await page.goto("/learn");
  await page.getByTestId("continue-link").click();
  await expect(page).toHaveURL(/hadeethenc-2945\?lang=ar#hadith-explanation$/);
  await expect(target).toBeInViewport();
  await expect(target).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  expect(await noPlayback(page)).toBe(true);
  await shot(page, info.project.name, "hadith-continue");

  const saved = JSON.parse((await stored(page))!);
  for (const change of [{ sha256: "b".repeat(64) }, { version: "balligh.library.hadith/999" }]) {
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [READING_KEY, JSON.stringify({ ...saved, last: { ...saved.last, ...change } })]);
    await page.goto("/learn");
    await expect(page.getByTestId("continue-stale")).toBeVisible();
    await expect(page.getByTestId("continue-link")).toHaveCount(0);
    await page.goto(`${HADITH}?lang=ar#hadith-explanation`);
    await expect(page.getByTestId("item-title")).toBeVisible();
    await expect(page.getByTestId("restore-fallback")).toHaveAttribute("data-reason", "stale");
    await expect(page.getByTestId("restore-fallback")).toContainText("لم يعد يطابق");
    await expect(target).not.toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  }
  await page.goto("/learn");
  await page.goto(`${HADITH}?lang=ar#hadith-nowhere`);
  await expect(page.getByTestId("item-title")).toBeVisible();
  await expect(page.getByTestId("restore-fallback")).toHaveAttribute("data-reason", "missing");
  await shot(page, info.project.name, "hadith-missing");
  expect(await otherKeys(page)).toEqual({ "balligh.lesson.v1": "LESSON-BYTES", "balligh.teacher.context.v1": "TEACHER-BYTES" });
});

test("reading storage failing only for its own key: notice inside the reader, in-memory place still continues", async ({ page }, info) => {
  await page.addInitScript((k) => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key: string) {
      if (key === k) throw new Error("blocked");
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === k) throw new Error("blocked");
      return set.call(this, key, value);
    };
  }, READING_KEY);
  await page.goto(FATWA);
  await expect(page.getByTestId("item-title")).toBeVisible();
  const notice = page.getByTestId("fatwa-reader").getByTestId("reading-notice");
  await expect(notice).toHaveAttribute("data-notice", "unavailable");
  const save = page.getByTestId("reader-save").getByTestId("save-place");
  await page.locator("#fatwa-answer").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(save).toHaveAttribute("data-anchor", "fatwa-answer");
  await save.click();
  await expect(page.getByTestId("reader-save").getByTestId("save-place-status")).toHaveText("حُفظ موضعك ما دامت هذه الصفحة مفتوحة فقط.");
  await shot(page, info.project.name, "fatwa-storage-notice");
  await page.getByRole("navigation", { name: "التنقل الرئيسي" }).getByRole("link", { name: "تعلّم" }).click();
  await page.getByTestId("continue-link").click();
  await expect(page.locator("#fatwa-answer")).toBeInViewport();
  await expect(page.locator("#fatwa-answer")).toBeFocused();
  await expect(page.getByTestId("fatwa-reader").getByTestId("reading-notice")).toBeVisible();
  expect(await otherKeys(page)).toEqual({ "balligh.lesson.v1": "LESSON-BYTES", "balligh.teacher.context.v1": "TEACHER-BYTES" });
});

test("malformed stored place: bytes preserved, notice inside the hadith reader, save stays in memory", async ({ page }) => {
  await page.evaluate((k) => localStorage.setItem(k, '{"schema":"broken"'), READING_KEY);
  await page.goto(HADITH);
  await expect(page.getByTestId("item-title")).toBeVisible();
  await expect(page.getByTestId("hadith-reader").getByTestId("reading-notice")).toHaveAttribute("data-notice", "malformed");
  const save = page.getByTestId("reader-save").getByTestId("save-place");
  await page.locator("#hadith-explanation").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(save).toHaveAttribute("data-anchor", "hadith-explanation");
  await save.click();
  await expect(page.getByTestId("reader-save").getByTestId("save-place-status")).toHaveText("حُفظ موضعك ما دامت هذه الصفحة مفتوحة فقط.");
  expect(await stored(page)).toBe('{"schema":"broken"');
  expect(await otherKeys(page)).toEqual({ "balligh.lesson.v1": "LESSON-BYTES", "balligh.teacher.context.v1": "TEACHER-BYTES" });
});
