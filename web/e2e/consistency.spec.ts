import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = resolve(HERE, "../../docs/review/G4-B-P1");
const LIVE = resolve(HERE, "../../server/tests/fixtures/live");
const KEY = "balligh.workspace.v1";
mkdirSync(`${EVIDENCE}/screenshots`, { recursive: true });
mkdirSync(`${EVIDENCE}/test-inputs`, { recursive: true });

type Json = Record<string, any>;
type Step = { delayMs?: number; fail?: boolean };

const A = "src-g1-local-note-ar";
const B = "src-g2-negation-ar";
const A_TEXT = "الإحالة إلى المصدر";
const B_TEXT = "الملف المشترك";
const ZEROS = "0".repeat(64);
const FIXTURE_ID = "g1-citation-lesson-en";

const readJson = (name: string): Json => JSON.parse(readFileSync(`${LIVE}/${name}`, "utf8"));
const realExport = () => readJson("g2-live-export-en-f034a415.json");
const negationDraft = () => readJson("g2-live-draft-negation-280bbb02.json");
const stored = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), KEY);
const status = (page: Page) => page.getByTestId("review-status").first().getAttribute("data-status");
const shot = (page: Page, project: string, name: string) =>
  page.screenshot({ path: `${EVIDENCE}/screenshots/${project}-P1-${name}.png`, fullPage: true });

function inputFile(name: string, envelope: Json) {
  const path = `${EVIDENCE}/test-inputs/${name}`;
  writeFileSync(path, JSON.stringify(envelope));
  return path;
}

async function stubHealth(page: Page) {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        status: "ok",
        version: "stub",
        sources_loaded: 4,
        generation: {
          enabled: true,
          configured: true,
          provider: "deepseek",
          model: "deepseek-v4-pro",
          locales: ["en", "ur", "zh-Hans", "id", "bn", "fr"],
          max_in_flight: 2,
          in_flight: 0,
        },
        provider_audio: { enabled: false, planned_phase: "G4" },
        product_model: "deepseek-v4-pro",
      },
    }),
  );
}

async function captureGenerate(page: Page) {
  const seen: Json[] = [];
  await page.route("**/api/drafts/generate", async (route: Route) => {
    seen.push(route.request().postDataJSON() as Json);
    await route.fulfill({
      status: 503,
      json: { detail: { code: "busy", message: "stub", retryable: true, diagnostic_id: "stub-1" } },
    });
  });
  return seen;
}

async function delay(page: Page, pattern: string, plan: Step[]) {
  let calls = 0;
  await page.route(pattern, async (route: Route) => {
    const step = plan[Math.min(calls++, plan.length - 1)] ?? {};
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    try {
      if (step.fail) await route.fulfill({ status: 500, json: { detail: "stubbed failure" } });
      else await route.continue();
    } catch {
      return;
    }
  });
}

async function sourceRecord(page: Page, id: string): Promise<Json> {
  const list = (await (await page.request.get("/api/sources")).json()) as Json[];
  return list.find((s) => s.id === id) as Json;
}

async function openSetup(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/setup");
  await page.getByTestId("library-toggle").click(); // G5-B: the library choice sits behind the pasted-text form
  await page.getByTestId(`source-option-${A}`).getByRole("radio").check();
}

async function openFixtureOnReview(page: Page) {
  await page.getByRole("button", { name: "افتح المسودة الاختبارية" }).click();
  await expect(page).toHaveURL(/\/review$/);
}

for (const late of ["success", "failure"] as const) {
  test(`preview: a late ${late} for the previously selected source is ignored`, async ({ page }) => {
    await stubHealth(page);
    const seen = await captureGenerate(page);
    const b = await sourceRecord(page, B);
    await delay(page, `**/api/sources/${A}`, [{ delayMs: 2500, fail: late === "failure" }]);
    await openSetup(page);
    await page.getByRole("radio", { name: b.title }).check();
    const preview = page.getByTestId("source-preview");
    await expect(preview).toContainText(B_TEXT);
    await page.waitForTimeout(3000);
    await expect(preview).toContainText(B_TEXT);
    await expect(preview).not.toContainText(A_TEXT);
    await page.getByTestId("generate").click();
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ source_id: B, source_version: b.source_version, source_sha256: b.content_sha256 });
  });
}

test("preview: a loading or failed selection hides the previous text, explains itself and keeps generation off", async ({
  page,
}, info) => {
  await stubHealth(page);
  const a = await sourceRecord(page, A);
  const b = await sourceRecord(page, B);
  await delay(page, `**/api/sources/${B}`, [{ delayMs: 2500 }, { fail: true }, {}]);
  await openSetup(page);
  const preview = page.getByTestId("source-preview");
  const generate = page.getByTestId("generate");
  await expect(preview).toContainText(A_TEXT);
  await expect(generate).toBeEnabled();

  await page.getByRole("radio", { name: b.title }).check();
  await expect(generate).toBeDisabled();
  await expect(preview).not.toContainText(A_TEXT);
  await expect(page.getByTestId("source-status")).toContainText("جارٍ تحميل نص المصدر");
  await shot(page, info.project.name, "source-loading");
  await expect(preview).toContainText(B_TEXT);
  await expect(generate).toBeEnabled();

  await page.getByRole("radio", { name: a.title }).check();
  await expect(preview).toContainText(A_TEXT);
  await page.getByRole("radio", { name: b.title }).check();
  const failed = page.getByTestId("source-failed");
  await expect(failed).toContainText("تعذّر تحميل نص المصدر");
  await expect(generate).toBeDisabled();
  await expect(page.getByTestId("generate-off")).toHaveCount(0);
  await expect(preview).not.toContainText(A_TEXT);
  await shot(page, info.project.name, "source-failed");
  await failed.getByRole("button", { name: "أعد التحميل" }).click();
  await expect(preview).toContainText(B_TEXT);
  await expect(generate).toBeEnabled();
});

for (const variant of ["loading", "late-success", "late-failure"] as const) {
  test(`original: a different-source import on the open Review page never shows the old source (${variant})`, async ({
    page,
  }, info) => {
    const mobile = info.project.name.startsWith("mobile");
    const bDraft = negationDraft();
    const bFile = inputFile("negation-live-draft-export.json", { format: "balligh.export/1", draft: bDraft });
    await openSetup(page);
    await openFixtureOnReview(page);
    if (mobile) await page.getByRole("tab", { name: "الأصل" }).click();
    await expect(page.getByTestId("original-text")).toContainText(A_TEXT);

    await page.getByRole("link", { name: "الإعداد" }).click();
    await delay(page, "**/api/drafts/import", [{ delayMs: 1500 }]);
    await delay(page, `**/api/sources/${A}`, variant === "loading" ? [{}] : [{ delayMs: 4000, fail: variant === "late-failure" }]);
    await delay(page, `**/api/sources/${B}`, variant === "loading" ? [{ delayMs: 3000 }] : [{}]);
    await page.getByTestId("import-input").setInputFiles(bFile);
    await page.getByRole("link", { name: "المراجعة" }).click();
    if (mobile) await page.getByRole("tab", { name: "الأصل" }).click();
    if (variant === "loading") await expect(page.getByTestId("original-text")).toContainText(A_TEXT);
    await page.getByRole("button", { name: "استبدل بالملف المستورد" }).click();
    await expect(page.getByText("تم الاستيراد")).toBeVisible();

    if (variant === "loading") {
      const stale = page.getByTestId("original-text");
      const text = (await stale.count()) ? await stale.innerText() : "";
      expect(text).not.toContain(A_TEXT);
      await expect(page.getByTestId("original-status")).toContainText("جارٍ تحميل النص الأصلي");
      await shot(page, info.project.name, "original-switch-loading");
    }
    await expect(page.getByTestId("original-text")).toContainText(B_TEXT, { timeout: 8000 });
    await page.waitForTimeout(variant === "loading" ? 500 : 3500);
    const original = page.getByTestId("original-text");
    const finalText = await original.innerText({ timeout: 2000 });
    expect(finalText).toContain(B_TEXT);
    expect(finalText).not.toContain(A_TEXT);
    const marks = (await original.locator("mark").allInnerTexts()).map((s) => s.trim());
    expect(marks).toEqual(bDraft.spans.map((s: Json) => String(s.exact_text).trim()));
  });
}

test("changing source, language or level closes a pending replacement; a fresh Generate sends what is shown", async ({
  page,
}, info) => {
  await stubHealth(page);
  const seen = await captureGenerate(page);
  const b = await sourceRecord(page, B);
  await openSetup(page);
  await openFixtureOnReview(page);
  await page.getByRole("link", { name: "الإعداد" }).click();
  await page.getByTestId("library-toggle").click(); // G5-B: the library choice sits behind the pasted-text form
  const confirm = page.getByTestId("gen-confirm");
  const generate = page.getByTestId("generate");
  const changes: { apply: () => Promise<unknown>; sent: Json }[] = [
    {
      apply: () => page.getByRole("radio", { name: b.title }).check(),
      sent: { source_id: B, source_version: b.source_version, source_sha256: b.content_sha256, target_locale: "en", level: "foundational" },
    },
    { apply: () => page.locator("main select").selectOption("fr"), sent: { source_id: B, target_locale: "fr", level: "foundational" } },
    { apply: () => page.getByRole("radio", { name: "أكثر تفصيلًا" }).check(), sent: { source_id: B, target_locale: "fr", level: "detailed" } },
  ];
  for (const [i, change] of changes.entries()) {
    await expect(generate).toBeEnabled();
    await generate.click();
    await expect(confirm).toBeVisible();
    await change.apply();
    await expect(confirm).toHaveCount(0);
    expect(seen).toHaveLength(i);
    if (i === 0) await shot(page, info.project.name, "confirm-closed-after-change");
    await expect(generate).toBeEnabled();
    await generate.click();
    await page.getByRole("button", { name: "ولّد واستبدل" }).click();
    await expect.poll(() => seen.length).toBe(i + 1);
    expect(seen[i]).toMatchObject(change.sent);
    await expect(page.getByTestId("gen-failed")).toBeVisible();
  }
  await page.locator("main select").selectOption("en");
  await expect(page.getByTestId("gen-failed")).toHaveCount(0);
  expect(seen).toHaveLength(3);
  expect((await stored(page)).draft.id).toBe(FIXTURE_ID);
});

test("inconsistent imports are refused without touching open work; the real live export imports unacknowledged", async ({
  page,
}, info) => {
  await openSetup(page);
  await openFixtureOnReview(page);
  await page.getByRole("link", { name: "الإعداد" }).click();
  const tampers: [string, (d: Json) => void, string][] = [
    ["test-flag-false", (d) => (d.is_test_data = false), "is_test_data must be true"],
    ["input-hash-zeros", (d) => (d.input_hash = ZEROS), "input_hash does not match"],
    ["generation-hash-zeros", (d) => (d.generation.source_sha256 = ZEROS), "generation.source_sha256 does not match"],
  ];
  for (const [name, tamper, message] of tampers) {
    const envelope = realExport();
    tamper(envelope.draft);
    await page.getByTestId("import-input").setInputFiles(inputFile(`tampered-${name}.json`, envelope));
    await expect(page.getByTestId("error-notice")).toContainText(message);
    await expect(page.getByText("تم الاستيراد")).toHaveCount(0);
    await expect(page).toHaveURL(/\/setup$/);
    expect((await stored(page)).draft.id).toBe(FIXTURE_ID);
    if (name === "test-flag-false") await shot(page, info.project.name, "import-rejected");
  }

  await page.getByTestId("import-input").setInputFiles(`${LIVE}/g2-live-export-en-f034a415.json`);
  await page.getByRole("button", { name: "استبدل بالملف المستورد" }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expect.poll(() => status(page)).toBe("draft");
  const panel = page.getByTestId("origin-panel");
  await expect(panel).toHaveAttribute("data-origin", "live");
  await expect(panel).toContainText("deepseek-v4-pro");
  const saved = await stored(page);
  expect(saved.draft.id).toBe(realExport().draft.id);
  expect(saved.draft.generation).toMatchObject({ origin: "live", human_edited: true });
  expect(saved.review).toBeNull();
  await page.goto("/preview");
  await expect(page.getByTestId("ai-draft-banner")).toBeVisible();
});

test("fixture and manual origins are shown as declared, never as proof that no AI was used", async ({ page }, info) => {
  await openSetup(page);
  await openFixtureOnReview(page);
  const panel = page.getByTestId("origin-panel");
  await expect(panel).toHaveAttribute("data-origin", "fixture");
  await expect(panel).toContainText("المنشأ المُعلن: مسودة اختبارية");
  await expect(panel).not.toContainText("لم يُستخدم فيها نموذج");

  const envelope = realExport();
  envelope.draft.generation = { origin: "manual" };
  for (const card of envelope.draft.cards) card.derivation = card.kind === "quote" ? "team_translation" : "derived_explanation";
  await page.getByRole("link", { name: "الإعداد" }).click();
  await page.getByTestId("import-input").setInputFiles(inputFile("declared-manual.json", envelope));
  await page.getByRole("button", { name: "استبدل بالملف المستورد" }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(panel).toHaveAttribute("data-origin", "manual");
  await expect(panel).toContainText("المنشأ المُعلن: يدوي");
  await expect(panel).not.toContainText("مكتوبة يدويًا");
  await shot(page, info.project.name, "declared-origin");
  await page.goto("/preview");
  await expect(page.getByTestId("lesson")).toBeVisible();
  await expect(page.getByTestId("ai-draft-banner")).toHaveCount(0);
});
