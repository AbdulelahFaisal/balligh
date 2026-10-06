import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const openAuthor = async (page: Page) => {
  if (!new URL(page.url()).pathname.endsWith("/preview")) return;
  await page.getByTestId("import-input").waitFor({ state: "attached" });
  const d = page.getByTestId("author-toolbar");
  if ((await d.count()) === 0) return;
  if ((await d.getAttribute("open")) === null) await d.locator("summary").click();
};

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = resolve(HERE, "../../docs/review/G4-B-P1");
const KEY = "balligh.workspace.v1";
mkdirSync(`${EVIDENCE}/screenshots`, { recursive: true });

type Json = Record<string, any>;

async function fixtureDraft(page: Page): Promise<Json> {
  const res = await page.request.get("/api/examples/g1-citation-lesson-en");
  expect(res.status()).toBe(200);
  return (await res.json()).draft;
}

async function seed(page: Page, bytes: string) {
  await page.goto("/sources");
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, bytes]);
}

const status = (page: Page) => page.getByTestId("review-status").first().getAttribute("data-status");
const RESET = "احذف البيانات المحفوظة واستأنف الحفظ";

test("nested-malformed stored data enters recovery and the bytes are preserved", async ({ page }, info) => {
  const base = await fixtureDraft(page);
  const cases: Record<string, (d: Json) => Json> = {
    "terms: [null]": (d) => ({ ...d, terms: [null] }),
    "activity.options: [null]": (d) => ({ ...d, activity: { ...d.activity, options: [null] } }),
    "activity.question is an object": (d) => ({ ...d, activity: { ...d.activity, question: { q: 1 } } }),
    "cards[0].editor_note is an object": (d) => ({
      ...d,
      cards: [{ ...d.cards[0], editor_note: { n: 1 } }, ...d.cards.slice(1)],
    }),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const bytes = JSON.stringify({ version: 1, draft: mutate(base), review: null });
    await seed(page, bytes);
    await page.goto("/review");
    await expect(page.getByTestId("storage-recovery"), name).toBeVisible();
    await expect(page.getByTestId("storage-recovery")).toHaveAttribute("data-kind", "unreadable");
    await expect(page.getByRole("link", { name: "بلّغ — البداية" }), `${name}: the app did not crash`).toBeVisible();
    await expect(page.getByTestId("card-text-card-1")).toHaveCount(0);
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY), name).toBe(bytes);
  }
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-P2-nested-recovery.png` });
});

test("a safe incomplete draft (empty title and card text) is restored, not sent to recovery", async ({ page }) => {
  const base = await fixtureDraft(page);
  const draft = { ...base, title: "", cards: [{ ...base.cards[0], text: "" }, ...base.cards.slice(1)] };
  await seed(page, JSON.stringify({ version: 1, draft, review: null }));
  await page.goto("/review");
  await expect(page.getByTestId("storage-recovery")).toHaveCount(0);
  await expect(page.getByLabel("عنوان الدرس")).toHaveValue("");
  await expect(page.getByTestId("card-text-card-1")).toHaveValue("");
  await expect.poll(() => status(page), { timeout: 5000 }).toBe("unverified");
});

test("getItem throwing while setItem works is unknown, not empty: zero automatic writes", async ({ page }, info) => {
  const base = await fixtureDraft(page);
  const bytes = JSON.stringify({ version: 1, draft: base, review: null });
  await seed(page, bytes);
  await page.addInitScript((k) => {
    const w = window as unknown as Record<string, unknown>;
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    w.__setCalls = 0;
    w.__readStored = () => get.call(window.localStorage, k);
    Storage.prototype.getItem = function (key: string) {
      if (key === k) throw new DOMException("blocked", "SecurityError");
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === k) (w.__setCalls as number)++;
      return set.call(this, key, value);
    };
  }, KEY);
  await page.goto("/");
  const rec = page.getByTestId("storage-recovery");
  await expect(rec).toBeVisible();
  await expect(rec).toHaveAttribute("data-kind", "unavailable");
  await expect(page.getByTestId("storage-paused")).toBeVisible();

  await page.getByRole("button", { name: "جرّب درسًا" }).click();
  await expect(page.getByTestId("lesson")).toBeVisible();
  await page.getByRole("button", { name: "تكبير النص" }).click();
  await expect(rec).toBeVisible();
  await expect(page.getByTestId("storage-note")).toHaveCount(0);
  await openAuthor(page);
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/export/json")),
    page.getByRole("button", { name: "صدّر JSON" }).click(),
  ]);
  expect(res.status()).toBe(200);

  expect(await page.evaluate(() => (window as unknown as Record<string, number>).__setCalls)).toBe(0);
  expect(await page.evaluate(() => (window as unknown as Record<string, () => string>).__readStored())).toBe(bytes);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-P2-read-unavailable.png` });
});

test("inaccessible storage is reported as unknown; editing and export work; reset visibly fails", async ({ page }, info) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
  });
  await page.goto("/");
  const rec = page.getByTestId("storage-recovery");
  await expect(rec).toBeVisible();
  await expect(rec).toHaveAttribute("data-kind", "unavailable");
  await expect(rec).toContainText("تخزين المتصفح محجوب");
  await page.getByRole("button", { name: "جرّب درسًا" }).click();
  await expect(page.getByTestId("lesson")).toBeVisible();
  await page.getByRole("button", { name: "تكبير النص" }).click();
  await expect(page.getByTestId("storage-note")).toHaveCount(0);
  await openAuthor(page);
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/export/html")),
    page.getByRole("button", { name: "صدّر HTML" }).click(),
  ]);
  expect(res.status()).toBe(200);

  await rec.getByRole("button", { name: RESET }).click();
  await expect(rec.getByTestId("storage-reset-failed")).toBeVisible();
  await expect(rec).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-P2-inaccessible-reset-failed.png` });
});

test("a failed reset is visible in the recovery panel and loses nothing; a later reset resumes saving", async ({ page }, info) => {
  const bytes = '{"version":1,"draft":"broken';
  await seed(page, bytes);
  await page.addInitScript((k) => {
    const w = window as unknown as Record<string, unknown>;
    const remove = Storage.prototype.removeItem;
    const set = Storage.prototype.setItem;
    w.__failRemove = true;
    w.__setCalls = 0;
    Storage.prototype.removeItem = function (key: string) {
      if (w.__failRemove) throw new DOMException("blocked", "SecurityError");
      return remove.call(this, key);
    };
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === k) (w.__setCalls as number)++;
      return set.call(this, key, value);
    };
  }, KEY);
  await page.goto("/");
  const rec = page.getByTestId("storage-recovery");
  await expect(rec).toHaveAttribute("data-kind", "unreadable");

  await rec.getByRole("button", { name: RESET }).click();
  await expect(rec.getByTestId("storage-reset-failed")).toBeVisible();
  await expect(rec).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe(bytes);
  expect(await page.evaluate(() => (window as unknown as Record<string, number>).__setCalls)).toBe(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-P2-reset-failed.png` });

  await page.evaluate(() => ((window as unknown as Record<string, boolean>).__failRemove = false));
  await rec.getByRole("button", { name: RESET }).click();
  await expect(page.getByTestId("storage-recovery")).toHaveCount(0);
  await page.getByRole("button", { name: "جرّب درسًا" }).click();
  await expect(page.getByTestId("lesson")).toBeVisible();
  await expect(page.getByTestId("storage-note")).toBeVisible();
  await expect
    .poll(() => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "{}").draft?.id ?? null, KEY))
    .toBe("g1-citation-lesson-en");
});
