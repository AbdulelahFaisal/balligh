import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../../docs/review/G5-C/screenshots-library");
mkdirSync(SHOTS, { recursive: true });

type Json = Record<string, any>;

const shot = (page: Page, project: string, name: string) =>
  page.screenshot({ path: `${SHOTS}/${project}-${name}.png`, fullPage: true });

async function api(page: Page, path: string): Promise<Json> {
  const res = await page.request.get(path);
  expect(res.ok(), `${path} → ${res.status()}`).toBe(true);
  return res.json();
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
});

test("library home shows three clear destinations with real record counts", async ({ page }, info) => {
  const index = await api(page, "/api/library");
  const c = index.collections;
  await page.goto("/library");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("المكتبة");

  const quran = page.getByTestId("collection-quran");
  const fatwas = page.getByTestId("collection-questions");
  const hadith = page.getByTestId("collection-hadith");
  await expect(quran).toContainText("القرآن الكريم");
  await expect(fatwas).toContainText("فتاوى");
  await expect(hadith).toContainText("أحاديث صحيحة");

  // One short description per destination, and the real count from the API.
  await expect(quran).toContainText("استمع إلى التلاوة");
  await expect(page.getByTestId("collection-quran-count")).toContainText(String(c.quran.range.ayah_count));
  await expect(page.getByTestId("collection-questions-count")).toContainText(String(c.fatwa.count));
  await expect(page.getByTestId("collection-hadith-count")).toContainText(String(c.hadith.count));

  // The fatwa card states the reading languages the catalog actually covers: Arabic plus those with stored translations.
  const extra = Object.values((c.fatwa.machine_translations ?? {}) as Record<string, number>).filter((n) => n > 0).length;
  await expect(page.getByTestId("collection-questions-languages")).toHaveText(extra > 0 ? `العربية + ${extra} لغات` : "بالعربية فقط");
  await expect(page.getByTestId("collection-quran-languages")).toHaveCount(0);

  // Dense coverage explanations stay off the browsing view.
  await expect(page.getByTestId("library-home").getByTestId("coverage-line")).toHaveCount(0);

  // Each destination is a single keyboard-reachable link with a visible focus ring.
  await quran.focus();
  await expect(quran).toBeFocused();
  const outline = await quran.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");
  await noHorizontalOverflow(page);
  await shot(page, info.project.name, "library-home");

  await fatwas.click();
  await expect(page).toHaveURL(/\/library\/questions$/);
  await page.goBack();
  await hadith.click();
  await expect(page).toHaveURL(/\/library\/hadith$/);
});

test("collection list: search comes first, and an empty search offers a clear reset", async ({ page }, info) => {
  const all = await api(page, "/api/library/fatwas?page=1&page_size=1");
  await page.goto("/library/questions");
  const search = page.getByTestId("library-search");
  await expect(search).toBeVisible();
  await expect(page.getByTestId("item-link").first()).toBeVisible();
  // The search field is the first control of the filters block.
  const firstControl = await page.locator(".bl-filters > *").first().evaluate((el) => el.getAttribute("role"));
  expect(firstControl).toBe("search");
  // The reading-language choice appears once.
  await expect(page.getByTestId("questions-list").getByRole("combobox")).toHaveCount(1);
  await noHorizontalOverflow(page);
  await shot(page, info.project.name, "collection-list");

  await search.fill("كلمةلاتوجدفيأيعنوانxyz");
  await search.press("Enter");
  await expect(page.getByTestId("library-empty")).toContainText("لا توجد نتائج تطابق");
  const reset = page.getByTestId("library-empty-reset");
  await expect(reset).toHaveText("مسح البحث وعرض الكل");
  await noHorizontalOverflow(page);
  await shot(page, info.project.name, "collection-empty-search");
  await reset.click();
  await expect(search).toHaveValue("");
  await expect(page).not.toHaveURL(/q=/);
  await expect(page.getByTestId("result-count")).toContainText(String(all.total));
  await expect(page.getByTestId("item-link").first()).toBeVisible();
});
