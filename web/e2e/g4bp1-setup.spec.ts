import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = resolve(HERE, "../../docs/review/G4-B-P1/teacher");
mkdirSync(`${EVIDENCE}/screenshots`, { recursive: true });

type Json = Record<string, any>;
const FIXTURE = "src-g1-local-note-ar";
const FIXTURE_TEXT = "الإحالة إلى المصدر";
const isReal = (s: Json) => s.is_test_data === false && !!s.library_record_id && !!s.canonical_url;

async function stubHealth(page: Page) {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        status: "ok",
        version: "stub",
        sources_loaded: 10,
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
    await route.fulfill({ status: 503, json: { detail: { code: "provider_busy", retryable: false } } });
  });
  return seen;
}

async function catalogue(page: Page): Promise<Json[]> {
  return (await page.request.get("/api/sources")).json();
}

async function fresh(page: Page, path = "/setup") {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto(path);
  if (path.startsWith("/setup") && !path.includes("source=")) await page.getByTestId("library-toggle").click(); // G5-B: the library choice sits behind the pasted-text form
}

const optionId = async (page: Page, group: string) =>
  ((await page.getByTestId(group).locator("[data-testid^=source-option-]").first().getAttribute("data-testid")) ?? "").replace(
    "source-option-",
    "",
  );

test("fresh Setup selects the first published source, not a technical example", async ({ page }, info) => {
  await stubHealth(page);
  const seen = await captureGenerate(page);
  const list = await catalogue(page);
  const real = list.filter(isReal);
  expect(isReal(list[0])).toBe(false);
  expect(real.length).toBeGreaterThan(0);
  await fresh(page);
  const preview = page.getByTestId("source-preview");
  await expect(preview).toHaveAttribute("data-source-id", real[0].id);
  await expect(preview).toHaveAttribute("data-state", "ready");
  expect(await optionId(page, "real-sources")).toBe(real[0].id);
  await expect(page.getByTestId(`source-option-${real[0].id}`).getByRole("radio")).toBeChecked();
  await expect(page.getByTestId(`source-option-${FIXTURE}`).getByRole("radio")).not.toBeChecked();
  await expect(page.getByTestId("source-meta")).toBeVisible();
  await expect(page.getByTestId("source-ai-note")).toBeVisible();
  await expect(page.getByTestId("source-fallback")).toHaveCount(0);
  await expect(page.getByTestId("generate")).toBeEnabled();
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-setup-fresh-real-default.png`, fullPage: true });
  expect(seen).toHaveLength(0);
  await page.getByTestId("generate").click();
  await expect.poll(() => seen.length).toBe(1);
  expect(seen[0]).toMatchObject({
    source_id: real[0].id,
    source_version: real[0].source_version,
    source_sha256: real[0].content_sha256,
    target_locale: "en",
    level: "foundational",
  });
});

test("a technical example stays selectable and an explicit choice survives a late default preview", async ({ page }, info) => {
  await stubHealth(page);
  const seen = await captureGenerate(page);
  const real = (await catalogue(page)).filter(isReal);
  await page.route(`**/api/sources/${real[0].id}`, async (route: Route) => {
    const res = await route.fetch();
    await new Promise((r) => setTimeout(r, 2000));
    await route.fulfill({ response: res });
  });
  await fresh(page);
  const fixture = page.getByTestId("technical-sources").getByTestId(`source-option-${FIXTURE}`);
  await fixture.getByRole("radio").check();
  const preview = page.getByTestId("source-preview");
  await expect(preview).toHaveAttribute("data-source-id", FIXTURE);
  await expect(preview).toHaveAttribute("data-state", "ready");
  await page.waitForTimeout(2500);
  await expect(preview).toHaveAttribute("data-source-id", FIXTURE);
  await expect(page.getByTestId("source-text")).toContainText(FIXTURE_TEXT);
  await expect(fixture.getByRole("radio")).toBeChecked();
  await expect(page.getByTestId("technical-sources")).toContainText("أمثلة تقنية");
  await expect(page.getByTestId("source-meta")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "افتح المسودة الاختبارية" })).toBeVisible();
  await page.locator("main select").selectOption("fr");
  await expect(preview).toHaveAttribute("data-source-id", FIXTURE);
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-setup-explicit-fixture.png`, fullPage: true });
  await page.getByTestId("generate").click();
  await expect.poll(() => seen.length).toBe(1);
  expect(seen[0]).toMatchObject({ source_id: FIXTURE, target_locale: "fr", level: "foundational" });
});

test("valid deep links win over the default and unsupported ones keep the guard", async ({ page }, info) => {
  await stubHealth(page);
  const seen = await captureGenerate(page);
  const real = (await catalogue(page)).filter(isReal);
  const preview = page.getByTestId("source-preview");
  await fresh(page, `/setup?source=${FIXTURE}`);
  for (const id of [FIXTURE, real[real.length - 1].id]) {
    await page.goto(`/setup?source=${id}`);
    await expect(preview).toHaveAttribute("data-source-id", id);
    await expect(preview).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId(`source-option-${id}`).getByRole("radio")).toBeChecked();
    await expect(page.getByTestId("source-unsupported")).toHaveCount(0);
    await expect(page.getByTestId("generate")).toBeEnabled();
  }
  for (const id of ["lib-quran-1", "src-unknown"]) {
    await page.goto(`/setup?source=${id}`);
    await expect(page.getByTestId("source-unsupported")).toContainText(id);
    await expect(page.getByTestId("generate")).toBeDisabled();
    await expect(preview).toHaveCount(0);
    await expect(page.locator("input[name=source]:checked")).toHaveCount(0);
  }
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-setup-unsupported-link.png`, fullPage: true });
  expect(seen).toHaveLength(0);
});

test("a preview whose hash differs from the listed record keeps generation off", async ({ page }) => {
  await stubHealth(page);
  const seen = await captureGenerate(page);
  const real = (await catalogue(page)).filter(isReal);
  await page.route(`**/api/sources/${real[0].id}`, async (route: Route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Json;
    await route.fulfill({ response: res, json: { ...body, record: { ...body.record, content_sha256: "0".repeat(64) } } });
  });
  await fresh(page);
  const preview = page.getByTestId("source-preview");
  await expect(preview).toHaveAttribute("data-source-id", real[0].id);
  await expect(preview).toHaveAttribute("data-state", "unavailable");
  await expect(page.getByTestId("source-text")).toHaveCount(0);
  await expect(page.getByTestId("generate")).toBeDisabled();
  expect(seen).toHaveLength(0);
});

test("with no published source available the first technical example is an honest fallback", async ({ page }, info) => {
  await stubHealth(page);
  await page.route("**/api/sources", async (route: Route) => {
    const res = await route.fetch();
    const list = (await res.json()) as Json[];
    await route.fulfill({ response: res, json: list.filter((s) => !isReal(s)) });
  });
  await fresh(page);
  await expect(page.getByTestId("real-sources")).toHaveCount(0);
  const first = await optionId(page, "technical-sources");
  const preview = page.getByTestId("source-preview");
  await expect(preview).toHaveAttribute("data-source-id", first);
  await expect(preview).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("source-fallback")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-setup-fallback.png`, fullPage: true });
});
