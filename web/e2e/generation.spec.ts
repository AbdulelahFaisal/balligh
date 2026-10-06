import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = resolve(HERE, "../../docs/review/G4-B-P1");
const KEY = "balligh.workspace.v1";
mkdirSync(`${EVIDENCE}/screenshots`, { recursive: true });
mkdirSync(`${EVIDENCE}/test-inputs`, { recursive: true });

type Json = Record<string, any>;

const status = (page: Page) => page.getByTestId("review-status").first().getAttribute("data-status");
const stored = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), KEY);

async function stubHealth(page: Page, configured = true) {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        status: "ok",
        version: "stub",
        sources_loaded: 4,
        generation: {
          enabled: configured,
          configured,
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

async function fixture(page: Page): Promise<Json> {
  const res = await page.request.get("/api/examples/g1-citation-lesson-en");
  return (await res.json()).draft;
}

function liveDraft(base: Json, requestId: string): Json {
  return {
    ...base,
    id: `gen-${requestId}`,
    title: `Stubbed AI draft ${requestId.slice(0, 4)}`,
    cards: base.cards.map((c: Json) => ({
      ...c,
      derivation: c.kind === "quote" ? "machine_translation" : "machine_explanation",
    })),
    generation: {
      origin: "live",
      provider: "deepseek",
      requested_model: "deepseek-v4-pro",
      returned_model: "deepseek-v4-pro",
      prompt_version: "g2-lesson-1",
      request_id: requestId,
      generated_at: "2026-10-06T02:00:00+03:00",
      source_sha256: base.input_hash,
      glossary_sha256: "a".repeat(64),
      settings: { thinking: "enabled", reasoning_effort: "high", response_format: "json_object", max_tokens: 16384 },
      usage: {
        prompt_tokens: 1800,
        completion_tokens: 2500,
        total_tokens: 4300,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 1800,
        reasoning_tokens: 2100,
      },
      latency_ms: 45000,
      note: "Stub used by the browser test; no provider was called.",
      human_edited: false,
      last_human_edit_at: null,
    },
  };
}

type Behaviour = { delayMs?: number; error?: { status: number; detail: Json } };

async function stubGenerate(page: Page, base: Json, plan: Behaviour[]) {
  const seen: Json[] = [];
  await page.route("**/api/drafts/generate", async (route: Route) => {
    const body = route.request().postDataJSON() as Json;
    seen.push(body);
    const step = plan[Math.min(seen.length - 1, plan.length - 1)] ?? {};
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    try {
      if (step.error) await route.fulfill({ status: step.error.status, json: { detail: step.error.detail } });
      else
        await route.fulfill({
          json: {
            draft: liveDraft(base, body.request_id),
            request_id: body.request_id,
            valid: true,
            errors: [],
            lesson_hash: "sha256:" + "0".repeat(64),
            status: "draft",
          },
        });
    } catch {
      return;
    }
  });
  return seen;
}

async function openSetup(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/setup?source=src-g1-local-note-ar");
  await expect(page.getByTestId("source-preview")).toContainText("الإحالة إلى المصدر");
}

async function openFixtureDraft(page: Page) {
  await page.getByRole("button", { name: "افتح المسودة الاختبارية" }).click();
  await expect(page).toHaveURL(/\/review$/);
  await page.goto("/setup?source=src-g1-local-note-ar");
}

test("no generation request on mount, reload or interface language change", async ({ page }) => {
  await stubHealth(page);
  const seen = await stubGenerate(page, await fixture(page), [{}]);
  await openSetup(page);
  await page.reload();
  await page.locator("header select").selectOption("en");
  await page.locator("header select").selectOption("ar");
  await page.getByRole("radio", { name: /الاستثناء في مراجعة الترجمة/ }).check();
  await expect(page.getByTestId("generate")).toBeEnabled();
  expect(seen).toHaveLength(0);
});

test("generate shows honest progress, blocks double submit and opens the AI draft for review", async ({ page }, info) => {
  await stubHealth(page);
  const seen = await stubGenerate(page, await fixture(page), [{ delayMs: 1500 }]);
  await openSetup(page);
  const button = page.getByTestId("generate");
  await button.click();
  await button.click({ force: true }).catch(() => undefined);
  await expect(page.getByTestId("gen-running")).toBeVisible();
  await expect(button).toBeDisabled();
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-G2-generating.png` });
  await expect(page).toHaveURL(/\/review$/, { timeout: 10000 });
  expect(seen).toHaveLength(1);
  expect(Object.keys(seen[0]).sort()).toEqual(
    ["level", "request_id", "source_id", "source_sha256", "source_version", "target_locale"].sort(),
  );
  expect(seen[0]).toMatchObject({ source_id: "src-g1-local-note-ar", target_locale: "en", level: "foundational" });
  await expect(page.getByRole("status").first()).toContainText("المسودة جاهزة");
  await expect(page.getByTestId("origin-panel")).toHaveAttribute("data-origin", "live");
  await expect(page.getByTestId("origin-panel")).toContainText("deepseek-v4-pro");
  await expect.poll(() => status(page)).toBe("draft");
  if (info.project.name.startsWith("mobile")) await page.getByRole("tab", { name: "الدرس" }).click();
  await expect(page.getByTestId("source-card").first()).toContainText("ترجمة آلية (غير مراجعة)");
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-G2-review-ai-draft.png` });

  await page.getByTestId("card-text-card-1").fill("Edited by the author after generation.");
  await expect(page.getByTestId("origin-edited")).toHaveAttribute("data-edited", "true");
  const saved = await stored(page);
  expect(saved.draft.generation).toMatchObject({ origin: "live", human_edited: true, request_id: seen[0].request_id });
  expect(saved.review).toBeNull();

  await page.goto("/preview");
  await expect(page.getByTestId("ai-draft-banner")).toBeVisible();
  await expect(page.getByTestId("lesson")).toContainText("Edited by the author after generation.");
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-G2-preview-ai-draft.png` });
});

test("replacing an open draft needs confirmation and keeping it changes nothing", async ({ page }) => {
  await stubHealth(page);
  const seen = await stubGenerate(page, await fixture(page), [{}]);
  await openSetup(page);
  await openFixtureDraft(page);
  await page.getByTestId("generate").click();
  await expect(page.getByTestId("gen-confirm")).toBeVisible();
  await page.getByRole("button", { name: "أبقِ المسودة الحالية" }).click();
  await expect(page.getByTestId("gen-confirm")).toHaveCount(0);
  expect(seen).toHaveLength(0);
  expect((await stored(page)).draft.id).toBe("g1-citation-lesson-en");

  await page.getByTestId("generate").click();
  await page.getByRole("button", { name: "ولّد واستبدل" }).click();
  await expect(page).toHaveURL(/\/review$/);
  expect(seen).toHaveLength(1);
  const saved = await stored(page);
  expect(saved.draft.id).toBe(`gen-${seen[0].request_id}`);
  expect(saved.review).toBeNull();
});

test("cancel keeps the current work and a cancelled result never applies", async ({ page }, info) => {
  await stubHealth(page);
  const seen = await stubGenerate(page, await fixture(page), [{ delayMs: 2500 }, {}]);
  await openSetup(page);
  await openFixtureDraft(page);
  await page.getByTestId("generate").click();
  await page.getByRole("button", { name: "ولّد واستبدل" }).click();
  await expect(page.getByTestId("gen-running")).toBeVisible();
  await page.getByRole("button", { name: "إلغاء" }).click();
  await expect(page.getByTestId("gen-cancelled")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-G2-cancelled.png` });
  expect((await stored(page)).draft.id).toBe("g1-citation-lesson-en");

  await page.getByTestId("generate").click();
  await page.getByRole("button", { name: "ولّد واستبدل" }).click();
  await expect(page).toHaveURL(/\/review$/);
  await page.waitForTimeout(3000);
  expect(seen).toHaveLength(2);
  expect((await stored(page)).draft.id).toBe(`gen-${seen[1].request_id}`);
});

test("navigating away or importing while generating never lets the late result replace work", async ({ page }) => {
  await stubHealth(page);
  const base = await fixture(page);
  const seen = await stubGenerate(page, base, [{ delayMs: 2000 }]);
  await openSetup(page);
  await page.getByTestId("generate").click();
  await expect(page.getByTestId("gen-running")).toBeVisible();
  await page.getByRole("link", { name: "المصادر والحدود" }).click();
  await page.waitForTimeout(2600);
  expect(seen).toHaveLength(1);
  expect(await stored(page)).toMatchObject({ draft: null });

  const exported = await (await page.request.post("/api/export/json", { data: { draft: base, review: null } })).json();
  const importPath = `${EVIDENCE}/test-inputs/fixture-export-for-import.json`;
  writeFileSync(importPath, JSON.stringify(exported));
  await page.goto("/setup?source=src-g1-local-note-ar");
  await page.getByTestId("generate").click();
  await expect(page.getByTestId("gen-running")).toBeVisible();
  await page.getByTestId("import-input").setInputFiles(importPath);
  await expect(page).toHaveURL(/\/review$/);
  await page.waitForTimeout(2600);
  expect(seen).toHaveLength(2);
  expect((await stored(page)).draft.id).toBe("g1-citation-lesson-en");
});

test("failures keep the current draft and offer retry only where it helps", async ({ page }, info) => {
  await stubHealth(page);
  const seen = await stubGenerate(page, await fixture(page), [
    {
      error: {
        status: 502,
        detail: { code: "invalid_output", message: "x", retryable: true, diagnostic_id: "abcd1234-a1" },
      },
    },
    {},
  ]);
  await openSetup(page);
  await openFixtureDraft(page);
  await page.getByTestId("generate").click();
  await page.getByRole("button", { name: "ولّد واستبدل" }).click();
  const failed = page.getByTestId("gen-failed");
  await expect(failed).toHaveAttribute("data-code", "invalid_output");
  await expect(failed).toContainText("لم تجتز إجابة النموذج فحوص الدرس");
  await expect(failed).toContainText("abcd1234-a1");
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-G2-error.png` });
  expect((await stored(page)).draft.id).toBe("g1-citation-lesson-en");
  await failed.getByRole("button", { name: "حاول مجددًا" }).click();
  await expect(page).toHaveURL(/\/review$/);
  expect(seen).toHaveLength(2);
  expect(seen[0].request_id).not.toBe(seen[1].request_id);
});

test("non-retryable failures and missing setup are explained without a retry button", async ({ page }) => {
  await stubHealth(page);
  await stubGenerate(page, await fixture(page), [
    { error: { status: 502, detail: { code: "provider_auth", message: "x", retryable: false, diagnostic_id: "k1" } } },
  ]);
  await openSetup(page);
  await page.getByTestId("generate").click();
  const failed = page.getByTestId("gen-failed");
  await expect(failed).toContainText("DEEPSEEK_API_KEY");
  await expect(failed.getByRole("button")).toHaveCount(0);
  expect(await stored(page)).toMatchObject({ draft: null });

  await page.unroute("**/api/health");
  await stubHealth(page, false);
  await page.reload();
  await expect(page.getByTestId("generate")).toBeDisabled();
  await expect(page.getByTestId("generate-off")).toContainText("DEEPSEEK_API_KEY");
});

test("generation controls work by keyboard", async ({ page }) => {
  await stubHealth(page);
  const seen = await stubGenerate(page, await fixture(page), [{ delayMs: 800 }]);
  await openSetup(page);
  await page.getByTestId("generate").focus();
  await expect(page.getByTestId("generate")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("gen-running")).toBeVisible();
  await expect(page).toHaveURL(/\/review$/, { timeout: 10000 });
  expect(seen).toHaveLength(1);
});
