import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/review/G4-B-P2/quran-restore");
mkdirSync(OUT, { recursive: true });

const READING_KEY = "balligh.reading.v1";
const SURAH = "/library/quran/78?lang=en";
const ANCHORED = `${SURAH}#ayah-31`;
const SURAH_78 = /\/api\/library\/quran\/78\?locale=en(&|$)/;

const stored = (page: Page) => page.evaluate((k) => localStorage.getItem(k), READING_KEY);
const playing = (page: Page) => page.evaluate(() => [...document.querySelectorAll("audio")].some((a) => !a.paused));
const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

async function saveAyah(page: Page, n: number) {
  await page.goto(SURAH);
  await page.locator(`[data-aya="${n}"]`).getByTestId("save-place").click();
  await expect.poll(() => stored(page)).toContain(`"anchor":"ayah-${n}"`);
  return JSON.parse((await stored(page))!);
}

async function reopen(page: Page, url: string) {
  await page.goto("about:blank");
  await page.goto(url);
}

async function hold(page: Page, pattern: RegExp) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(pattern, async (route: Route) => {
    await gate;
    await route.continue();
  });
  return release;
}

for (const change of [
  { name: "hash", patch: { sha256: "b".repeat(64) } },
  { name: "version", patch: { version: "english_saheeh.v0-old" } },
]) {
  test(`a saved Quran place with a stale ${change.name} shows the stale message and is not scrolled to or focused`, async ({ page }, info) => {
    const saved = await saveAyah(page, 31);
    const stale = JSON.stringify({ ...saved, last: { ...saved.last, ...change.patch } });
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [READING_KEY, stale]);
    await reopen(page, ANCHORED);
    await expect(page.getByTestId("surah-body")).toBeVisible();
    await expect(page.getByTestId("quran-restore-stale")).toBeVisible();
    await expect(page.getByTestId("quran-restore-stale")).toContainText("لم يعد يطابق");
    await page.waitForTimeout(400);
    await expect(page.locator("#ayah-31")).not.toBeFocused();
    await expect(page.locator("#ayah-31")).not.toBeInViewport();
    expect(await scrollY(page)).toBeLessThan(50);
    await expect(page.getByTestId("quran-restore-missing")).toHaveCount(0);
    expect(await playing(page)).toBe(false);
    expect(await stored(page)).toBe(stale);
    await page.screenshot({ path: `${OUT}/${info.project.name}-stale-${change.name}.png`, fullPage: false });
    await page.getByTestId("reading-language").selectOption("ur");
    await expect(page.getByTestId("surah-body")).toHaveAttribute("data-locale", "ur");
    await page.waitForTimeout(300);
    await expect(page.locator("#ayah-31")).not.toBeFocused();
    expect(await scrollY(page)).toBeLessThan(50);
    await expect(page.getByTestId("quran-restore-stale")).toBeVisible();
  });
}

test("a current saved Quran place restores only after the held text loads, with no playback", async ({ page }, info) => {
  await saveAyah(page, 31);
  const release = await hold(page, SURAH_78);
  await reopen(page, ANCHORED);
  await expect(page.getByTestId("surah-reader")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator("#ayah-31")).toHaveCount(0);
  release();
  await expect(page.locator("#ayah-31")).toBeInViewport();
  await expect(page.locator("#ayah-31")).toBeFocused();
  await expect(page.getByTestId("quran-restore-stale")).toHaveCount(0);
  await expect(page.getByTestId("quran-restore-missing")).toHaveCount(0);
  expect(await playing(page)).toBe(false);
  await page.screenshot({ path: `${OUT}/${info.project.name}-current-restored.png`, fullPage: false });
  const y = await scrollY(page);
  await page.locator("#ayah-1").scrollIntoViewIfNeeded();
  await page.getByTestId("tafsir-toggle").check();
  await page.waitForTimeout(400);
  await expect(page.locator("#ayah-31")).not.toBeFocused();
  expect(await scrollY(page)).toBeLessThan(y);
});

test("a direct anchor restores when the saved place is another ayah, even a stale one, and with no saved place", async ({ page }) => {
  const saved = await saveAyah(page, 5);
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [READING_KEY, JSON.stringify({ ...saved, last: { ...saved.last, sha256: "b".repeat(64) } })]);
  await reopen(page, ANCHORED);
  await expect(page.locator("#ayah-31")).toBeInViewport();
  await expect(page.locator("#ayah-31")).toBeFocused();
  await expect(page.getByTestId("quran-restore-stale")).toHaveCount(0);
  expect(await playing(page)).toBe(false);
  await page.evaluate((k) => localStorage.removeItem(k), READING_KEY);
  await reopen(page, ANCHORED);
  await expect(page.locator("#ayah-31")).toBeInViewport();
  await expect(page.locator("#ayah-31")).toBeFocused();
  await expect(page.getByTestId("quran-restore-stale")).toHaveCount(0);
});

test("an obsolete Surah 78 response cannot restore or mark the newer Surah 79 reader", async ({ page }) => {
  await saveAyah(page, 31);
  const release = await hold(page, SURAH_78);
  await reopen(page, ANCHORED);
  await page.getByTestId("surah-next").click();
  await expect(page).toHaveURL(/\/library\/quran\/79/);
  await expect(page.getByTestId("surah-body")).toBeVisible();
  release();
  await page.waitForTimeout(600);
  await expect(page.getByTestId("surah-reader")).toHaveAttribute("data-number", "79");
  expect(await page.evaluate(() => document.activeElement?.id ?? "")).not.toMatch(/^ayah-/);
  await expect(page.locator("#ayah-31")).not.toBeFocused();
  await expect(page.getByTestId("quran-restore-stale")).toHaveCount(0);
  await expect(page.getByTestId("quran-restore-missing")).toHaveCount(0);
});
