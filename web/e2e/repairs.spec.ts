import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
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
mkdirSync(`${EVIDENCE}/test-inputs`, { recursive: true });

const status = (page: Page) => page.getByTestId("review-status").first().getAttribute("data-status");
const expectStatus = (page: Page, s: string, timeout = 5000) => expect.poll(() => status(page), { timeout }).toBe(s);

async function openFixtureOnReview(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/setup?source=src-g1-local-note-ar");
  await page.getByRole("button", { name: "افتح المسودة الاختبارية" }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expectStatus(page, "draft");
}

function tabs(page: Page, mobile: boolean) {
  return async (name: string) => {
    if (mobile) await page.getByRole("tab", { name }).click();
  };
}

async function acknowledge(page: Page, openTab: (n: string) => Promise<void>) {
  await openTab("الإقرار");
  const panel = page.getByTestId("ack-panel");
  await panel.getByLabel("اسمك أو وسمك").fill("Tester");
  await panel.getByLabel("قارنت هذه النسخة بالمصدر").check();
  await panel.getByRole("button", { name: "أقرّ هذه النسخة" }).click();
  await expectStatus(page, "acknowledged_by_user");
}

test("G1-N09: status and acknowledgment follow the current draft", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  const openTab = tabs(page, mobile);
  await openFixtureOnReview(page);
  await acknowledge(page, openTab);
  const ackButton = page.getByTestId("ack-panel").getByRole("button", { name: "أقرّ هذه النسخة" });

  await openTab("الدرس");
  const card1 = page.getByTestId("card-text-card-1");
  const original = await card1.inputValue();
  await card1.fill("");
  expect(await status(page)).not.toBe("acknowledged_by_user");
  await expectStatus(page, "unverified");
  await openTab("الإقرار");
  await expect(page.getByTestId("validation-failure")).toBeVisible();
  await page.getByTestId("ack-panel").getByLabel("قارنت هذه النسخة بالمصدر").check();
  await expect(ackButton).toBeDisabled();
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-N09-invalid-edit.png` });
  await openTab("الدرس");
  await card1.fill(original);
  await expectStatus(page, "acknowledged_by_user");

  await page.route("**/api/drafts/validate", (r) => r.abort());
  await card1.fill(original + " net");
  await expectStatus(page, "unverified");
  await openTab("الإقرار");
  await expect(ackButton).toBeDisabled();
  await page.unroute("**/api/drafts/validate");
  await openTab("الدرس");
  await card1.fill(original);
  await expectStatus(page, "acknowledged_by_user");

  await page.route("**/api/drafts/validate", async (r) => {
    if ((r.request().postData() ?? "").includes("SLOW-EDIT")) await new Promise((res) => setTimeout(res, 2500));
    await r.continue();
  });
  await card1.fill(original + " SLOW-EDIT");
  await page.waitForTimeout(400);
  expect(await status(page)).toBe("checking");
  await card1.fill(original);
  await expectStatus(page, "acknowledged_by_user");
  await page.waitForTimeout(2800);
  expect(await status(page)).toBe("acknowledged_by_user");
  await page.unroute("**/api/drafts/validate");
});

test("G1-N09: a delayed acknowledgment does not attach to a changed draft", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  const openTab = tabs(page, mobile);
  await openFixtureOnReview(page);
  await page.route("**/api/reviews/acknowledge", async (r) => {
    await new Promise((res) => setTimeout(res, 1500));
    await r.continue();
  });
  await openTab("الإقرار");
  const panel = page.getByTestId("ack-panel");
  await panel.getByLabel("اسمك أو وسمك").fill("Tester");
  await panel.getByLabel("قارنت هذه النسخة بالمصدر").check();
  await panel.getByRole("button", { name: "أقرّ هذه النسخة" }).click();
  await openTab("الدرس");
  await page.getByTestId("card-text-card-1").fill("Changed while the acknowledgment was in flight.");
  await page.waitForTimeout(2200);
  await expectStatus(page, "draft");
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), KEY);
  expect(stored.review).toBeNull();
});

test("G1-N10: an import with invalid provenance keeps the current work", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  const openTab = tabs(page, mobile);
  await openFixtureOnReview(page);
  await openTab("الدرس");
  await page.getByTestId("card-note-card-2").fill("KEEP-ME");
  await acknowledge(page, openTab);
  const before = await page.evaluate((k) => localStorage.getItem(k), KEY);

  const envelope = await page.evaluate(async (k) => {
    const ws = JSON.parse(localStorage.getItem(k) ?? "null");
    const r = await fetch("/api/export/json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: ws.draft, review: ws.review }),
    });
    return r.json();
  }, KEY);
  envelope.draft.spans[0].exact_text = "x";
  envelope.draft.cards[1].editor_note = "FROM-BAD-FILE";
  const badPath = `${EVIDENCE}/test-inputs/${info.project.name}-quote-mismatch-import.json`;
  writeFileSync(badPath, JSON.stringify(envelope));

  await page.goto("/preview");
  await expectStatus(page, "acknowledged_by_user");
  await page.getByTestId("import-input").setInputFiles(badPath);
  await expect(page.getByTestId("error-notice")).toBeVisible();
  await expect(page.getByTestId("error-notice")).toContainText("exact_text does not match");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page).toHaveURL(/\/preview$/);
  await expect(page.getByTestId("lesson")).toContainText("KEEP-ME");
  await expect(page.getByTestId("lesson")).not.toContainText("FROM-BAD-FILE");
  await expectStatus(page, "acknowledged_by_user");
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe(before);
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-N10-rejected-import.png` });
});

test("G1-N11: unreadable stored data is preserved until explicit reset", async ({ page }, info) => {
  await page.goto("/sources");
  await page.evaluate((k) => localStorage.setItem(k, '{"version":1,"draft":"broken'), KEY);
  await page.reload();
  await expect(page.getByTestId("storage-recovery")).toBeVisible();
  await expect(page.getByTestId("storage-recovery")).toContainText("JSON تالف");

  await page.goto("/");
  await page.getByRole("button", { name: "جرّب درسًا" }).click();
  await expect(page.getByTestId("lesson")).toBeVisible();
  await expect(page.getByTestId("storage-recovery")).toBeVisible();
  await expect(page.getByTestId("storage-note")).toHaveCount(0);
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe('{"version":1,"draft":"broken');
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-N11-recovery.png` });

  for (const bad of ['{"version":2,"draft":null,"review":null}', '{"version":1,"draft":{"schema_version":"balligh.lesson/1"},"review":null}']) {
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, bad]);
    await page.reload();
    await expect(page.getByTestId("storage-recovery")).toBeVisible();
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe(bad);
  }

  await page.getByRole("button", { name: "احذف البيانات المحفوظة واستأنف الحفظ" }).click();
  await expect(page.getByTestId("storage-recovery")).toHaveCount(0);
  await page.goto("/");
  await page.getByRole("button", { name: "جرّب درسًا" }).click();
  await expect(page.getByTestId("lesson")).toBeVisible();
  await expect(page.getByTestId("storage-note")).toBeVisible();
  await expect
    .poll(() => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "{}").draft?.id ?? null, KEY))
    .toBe("g1-citation-lesson-en");
});

test("G1-N11: a failing save shows a persistent warning and editing still works", async ({ page }, info) => {
  await page.addInitScript((k) => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === k) throw new DOMException("quota", "QuotaExceededError");
      return real.call(this, key, value);
    };
  }, KEY);
  await page.goto("/");
  await page.getByRole("button", { name: "جرّب درسًا" }).click();
  await expect(page.getByTestId("lesson")).toBeVisible();
  await expect(page.getByTestId("storage-save-failed")).toBeVisible();
  await expect(page.getByTestId("storage-save-failed")).toContainText("غير محفوظة");
  await expect(page.getByTestId("storage-note")).toHaveCount(0);
  await page.getByRole("button", { name: "تكبير النص" }).click();
  await expect(page.getByTestId("storage-save-failed")).toBeVisible();
  await openAuthor(page);
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/export/json")),
    page.getByRole("button", { name: "صدّر JSON" }).click(),
  ]);
  expect(res.status()).toBe(200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-N11-save-failed.png` });
});
