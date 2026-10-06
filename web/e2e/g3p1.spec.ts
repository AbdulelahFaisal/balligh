import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const LIVE_FILE = resolve(HERE, "../../server/tests/fixtures/live/g2-live-export-en-f034a415.json");
const WS = "balligh.workspace.v1";
const PROGRESS = "balligh.progress.v1";
const EXAMPLE = "**/api/examples/g1-citation-lesson-en";
mkdirSync(`${EVIDENCE}/screenshots`, { recursive: true });
mkdirSync(`${EVIDENCE}/test-inputs`, { recursive: true });

type Json = Record<string, any>;

const live = (): Json => JSON.parse(readFileSync(LIVE_FILE, "utf8"));
const status = (page: Page) => page.getByTestId("review-status").first().getAttribute("data-status");
const expectStatus = (page: Page, s: string) => expect.poll(() => status(page), { timeout: 6000 }).toBe(s);
const raw = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);
const stored = async (page: Page) => JSON.parse((await raw(page, WS)) ?? "null");
const shot = (page: Page, project: string, name: string) =>
  page.screenshot({ path: `${EVIDENCE}/screenshots/${project}-P1-${name}.png`, fullPage: true });
const nav = (page: Page, name: "المراجعة" | "الدرس" | "الإعداد") =>
  page.getByRole("navigation", { name: "التنقل الرئيسي" }).getByRole("link", { name, exact: true }).click();

async function fixtureFile(page: Page) {
  const draft = (await (await page.request.get("/api/examples/g1-citation-lesson-en")).json()).draft;
  const path = `${EVIDENCE}/test-inputs/fixture-export.json`;
  writeFileSync(path, JSON.stringify({ format: "balligh.export/1", draft }));
  return path;
}

async function holdReads(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __reads: { go: () => void; fail: () => void }[] };
    w.__reads = [];
    const real = Blob.prototype.text;
    Blob.prototype.text = function (this: Blob) {
      return new Promise<string>((resolve, reject) => {
        w.__reads.push({
          go: () => void real.call(this).then(resolve, reject),
          fail: () => reject(new DOMException("read failed", "NotReadableError")),
        });
      });
    };
  });
}
const reads = (page: Page) => page.evaluate(() => (window as unknown as { __reads: unknown[] }).__reads.length);
const release = (page: Page, i: number) =>
  page.evaluate((n) => (window as unknown as { __reads: { go: () => void }[] }).__reads[n].go(), i);
const failRead = (page: Page, i: number) =>
  page.evaluate((n) => (window as unknown as { __reads: { fail: () => void }[] }).__reads[n].fail(), i);

function counter(page: Page, pattern: (url: string) => boolean) {
  const box = { n: 0 };
  page.on("request", (r) => {
    if (pattern(r.url())) box.n += 1;
  });
  return box;
}

async function delay(page: Page, pattern: string, ms: number) {
  await page.route(pattern, async (route: Route) => {
    await new Promise((r) => setTimeout(r, ms));
    try {
      await route.continue();
    } catch {
      return;
    }
  });
}

async function openLive(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/preview");
  await page.getByTestId("import-input").setInputFiles(LIVE_FILE);
  await expect(page).toHaveURL(/\/review$/);
  await expectStatus(page, "draft");
}

async function openTab(page: Page, mobile: boolean, name: string) {
  if (mobile) await page.getByRole("tab", { name }).click();
}

test("a held file read already owns the import: edits and clearing win, and a stale read failure is ignored", async ({
  page,
}, info) => {
  const mobile = info.project.name.startsWith("mobile");
  const imports = counter(page, (u) => u.endsWith("/api/drafts/import"));
  await openLive(page);
  const fixture = await fixtureFile(page);
  await nav(page, "الدرس");
  await holdReads(page);

  await page.getByTestId("import-input").setInputFiles(fixture);
  await expect(page.getByTestId("import-checking")).toBeVisible();
  await openAuthor(page);
  await expect(page.getByRole("button", { name: "جارٍ فحص الملف…" })).toBeDisabled();
  expect(await reads(page)).toBe(1);
  expect(imports.n).toBe(1);
  await shot(page, info.project.name, "read-held-busy");
  await nav(page, "المراجعة");
  await openTab(page, mobile, "الدرس");
  await page.getByLabel("عنوان الدرس").fill("Edited while the file was being read");
  await expect(page.getByText("لم يُطبَّق الاستيراد")).toBeVisible();
  await release(page, 0);
  await page.waitForTimeout(600);
  expect(imports.n).toBe(1);
  await expect(page.getByTestId("import-confirm")).toHaveCount(0);
  expect((await stored(page)).draft.title).toBe("Edited while the file was being read");

  await nav(page, "الدرس");
  await page.getByTestId("import-input").setInputFiles(fixture);
  await expect(page.getByTestId("import-checking")).toBeVisible();
  await page.getByRole("button", { name: "تكبير النص" }).click();
  await expect(page.getByText("لم يُطبَّق الاستيراد")).toBeVisible();
  await page.getByTestId("import-input").setInputFiles(fixture);
  await expect(page.getByTestId("import-checking")).toBeVisible();
  expect(await reads(page)).toBe(3);
  await failRead(page, 1);
  await page.waitForTimeout(400);
  await expect(page.getByTestId("error-notice")).toHaveCount(0);
  await expect(page.getByTestId("import-checking")).toBeVisible();
  await release(page, 2);
  await expect(page.getByTestId("import-confirm")).toBeVisible();
  expect(imports.n).toBe(2);
  const before = await raw(page, WS);
  await page.getByRole("button", { name: "أبقِ الدرس المفتوح" }).click();
  expect(await raw(page, WS)).toBe(before);

  await page.getByTestId("import-input").setInputFiles(fixture);
  await expect(page.getByTestId("import-checking")).toBeVisible();
  await openAuthor(page);
  await page.getByRole("button", { name: "امسح العمل المحلي" }).click();
  await expect(page.getByText("لم يُطبَّق الاستيراد")).toBeVisible();
  await release(page, 3);
  await page.waitForTimeout(600);
  expect(imports.n).toBe(2);
  expect((await stored(page)).draft).toBeNull();
  await expect(page.getByTestId("import-confirm")).toHaveCount(0);
});

test("a lesson generated while a file is read into an empty workspace is never replaced", async ({ page }) => {
  const imports = counter(page, (u) => u.endsWith("/api/drafts/import"));
  await page.route("**/api/health", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.generation = { ...body.generation, enabled: true, configured: true };
    await route.fulfill({ response: res, json: body });
  });
  const base = live().draft;
  await page.route("**/api/drafts/generate", async (route) => {
    const body = route.request().postDataJSON() as Json;
    await route.fulfill({
      json: {
        draft: { ...base, id: `gen-${body.request_id}`, title: "Generated while a file was read" },
        request_id: body.request_id,
        valid: true,
        errors: [],
        lesson_hash: "sha256:" + "0".repeat(64),
        status: "draft",
      },
    });
  });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/setup?source=src-g1-local-note-ar");
  await expect(page.getByTestId("source-preview")).toContainText("الإحالة إلى المصدر");
  await holdReads(page);
  await page.getByTestId("import-input").setInputFiles(await fixtureFile(page));
  await expect(page.getByTestId("import-checking")).toBeVisible();
  await page.getByTestId("generate").click();
  await expect(page).toHaveURL(/\/review$/);
  await expect.poll(async () => (await stored(page))?.draft?.title ?? null).toBe("Generated while a file was read");
  await release(page, 0);
  await page.waitForTimeout(600);
  expect(imports.n).toBe(0);
  await expect(page.getByTestId("import-confirm")).toHaveCount(0);
  expect((await stored(page)).draft.title).toBe("Generated while a file was read");
});

test("a second file chosen while the first is still being read is refused; only the first applies", async ({ page }, info) => {
  const imports = counter(page, (u) => u.endsWith("/api/drafts/import"));
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/preview");
  const fixture = await fixtureFile(page);
  await holdReads(page);
  await page.getByTestId("import-input").setInputFiles(LIVE_FILE);
  await expect(page.getByTestId("import-checking")).toBeVisible();
  await openAuthor(page);
  await expect(page.getByRole("button", { name: "جارٍ فحص الملف…" })).toBeDisabled();
  await page.getByTestId("import-input").setInputFiles(fixture);
  expect(await reads(page)).toBe(1);
  expect(imports.n).toBe(0);
  await shot(page, info.project.name, "second-file-refused");
  await release(page, 0);
  await expect(page).toHaveURL(/\/review$/);
  await expectStatus(page, "draft");
  expect((await stored(page)).draft.id).toBe(live().draft.id);
  await page.waitForTimeout(500);
  expect(imports.n).toBe(1);
  expect((await stored(page)).draft.id).toBe(live().draft.id);
});

test("opening the test draft over an open lesson asks first; declining keeps every byte, confirming replaces", async ({
  page,
}, info) => {
  const mobile = info.project.name.startsWith("mobile");
  await openLive(page);
  await openTab(page, mobile, "الإقرار");
  const panel = page.getByTestId("ack-panel");
  await panel.getByLabel("اسمك أو وسمك").fill("G3-P1 tester");
  await panel.getByLabel("قارنت هذه النسخة بالمصدر").check();
  await panel.getByRole("button", { name: "أقرّ هذه النسخة" }).click();
  await expectStatus(page, "acknowledged_by_user");
  await nav(page, "الدرس");
  await page.getByTestId("mark-read").click();
  await page.waitForTimeout(400);
  const workspaceBefore = await raw(page, WS);
  const progressBefore = await raw(page, PROGRESS);

  await nav(page, "الإعداد");
  await page.getByTestId("library-toggle").click(); // G5-B: the library choice sits behind the pasted-text form
  await page.getByTestId("source-option-src-g1-local-note-ar").getByRole("radio").check();
  await page.getByRole("button", { name: "افتح المسودة الاختبارية" }).click();
  const confirm = page.getByTestId("import-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveAttribute("data-kind", "example");
  await expect(confirm).toContainText("Citing Sources and Keeping Honesty");
  await expect(confirm).toContainText("Test lesson");
  await expect(confirm.getByRole("heading")).toBeFocused();
  await shot(page, info.project.name, "example-confirm");
  await page.getByRole("button", { name: "أبقِ الدرس المفتوح" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("لم تُفتح المسودة الاختبارية");
  await page.waitForTimeout(400);
  expect(await raw(page, WS)).toBe(workspaceBefore);
  expect(await raw(page, PROGRESS)).toBe(progressBefore);
  expect((await stored(page)).review?.status).toBe("acknowledged_by_user");

  await page.getByRole("button", { name: "افتح المسودة الاختبارية" }).click();
  await page.getByRole("button", { name: "استبدل بالمسودة الاختبارية" }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expectStatus(page, "draft");
  const after = await stored(page);
  expect(after.draft.id).toBe("g1-citation-lesson-en");
  expect(after.review).toBeNull();
  await nav(page, "الدرس");
  await expect(page.getByTestId("progress-count")).toHaveText("اكتملت 0 من 3 محطات");
});

test("a delayed test draft never overwrites newer work, and repeated clicks send one request (Setup and Start)", async ({
  page,
}, info) => {
  const mobile = info.project.name.startsWith("mobile");
  const examples = counter(page, (u) => u.includes("/api/examples/g1-citation-lesson-en"));
  await openLive(page);
  await delay(page, EXAMPLE, 2500);

  await nav(page, "الإعداد");
  await page.getByTestId("library-toggle").click(); // G5-B: the library choice sits behind the pasted-text form
  await page.getByTestId("source-option-src-g1-local-note-ar").getByRole("radio").check();
  const openButton = page.getByRole("button", { name: "افتح المسودة الاختبارية" });
  await openButton.click();
  await expect(openButton).toBeDisabled();
  await openButton.click({ force: true }).catch(() => undefined);
  await expect(page.getByTestId("import-checking")).toHaveAttribute("data-kind", "example");
  await openAuthor(page);
  await expect(page.getByRole("button", { name: "استورد JSON" })).toBeDisabled();
  await nav(page, "المراجعة");
  await openTab(page, mobile, "الدرس");
  await page.getByLabel("عنوان الدرس").fill("Edited while the test draft was loading");
  await expect(page.getByText("لم تُفتح المسودة الاختبارية")).toBeVisible();
  await shot(page, info.project.name, "example-superseded");
  await page.waitForTimeout(3000);
  await expect(page.getByTestId("import-confirm")).toHaveCount(0);
  expect(examples.n).toBe(1);
  let s = await stored(page);
  expect(s.draft.id).toBe(live().draft.id);
  expect(s.draft.title).toBe("Edited while the test draft was loading");

  await nav(page, "الإعداد");
  await page.getByTestId("library-toggle").click(); // G5-B: the library choice sits behind the pasted-text form
  await page.getByTestId("source-option-src-g1-local-note-ar").getByRole("radio").check();
  await openButton.click();
  await expect(page.getByTestId("import-checking")).toBeVisible();
  await nav(page, "الدرس");
  await openAuthor(page);
  await page.getByRole("button", { name: "امسح العمل المحلي" }).click();
  await page.waitForTimeout(3000);
  expect(examples.n).toBe(2);
  expect((await stored(page)).draft).toBeNull();
  await expect(page.getByTestId("import-confirm")).toHaveCount(0);

  await page.getByRole("link", { name: "بلّغ — البداية" }).click();
  const tryButton = page.getByRole("button", { name: "جرّب درسًا" });
  await tryButton.click();
  await expect(tryButton).toBeDisabled();
  await tryButton.click({ force: true }).catch(() => undefined);
  await expect(page).toHaveURL(/\/preview$/, { timeout: 8000 });
  expect(examples.n).toBe(3);
  s = await stored(page);
  expect(s.draft.id).toBe("g1-citation-lesson-en");

  await page.unroute(EXAMPLE);
  await page.getByRole("link", { name: "بلّغ — البداية" }).click();
  await page.getByRole("button", { name: "جرّب درسًا" }).click();
  await expect(page).toHaveURL(/\/preview$/);
  expect(examples.n).toBe(3);
});
