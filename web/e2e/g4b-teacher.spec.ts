import { expect, test, type Page, type Route } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = resolve(HERE, "../../docs/review/G4-B-P1/adapter");
mkdirSync(`${EVIDENCE}/screenshots`, { recursive: true });
mkdirSync(`${EVIDENCE}/exports`, { recursive: true });

type Json = Record<string, any>;
const SOURCE = "lib-fatwa-18975";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const status = (page: Page) => page.getByTestId("review-status").first().getAttribute("data-status");

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

async function realDraft(page: Page, requestId: string): Promise<Json> {
  const fixture = (await (await page.request.get("/api/examples/g1-citation-lesson-en")).json()).draft;
  const base = JSON.parse(JSON.stringify(fixture).replaceAll(fixture.source_ids[0], SOURCE));
  const { record, text } = await (await page.request.get(`/api/sources/${SOURCE}`)).json();
  const paragraphs: string[] = text.split("\n\n");
  const spans = base.spans.map((s: Json, i: number) => {
    const exact = paragraphs[(i + 1) % paragraphs.length];
    const start = text.indexOf(exact);
    return {
      ...s,
      source_id: SOURCE,
      source_version: record.source_version,
      source_sha256: record.content_sha256,
      start_offset: start,
      end_offset: start + exact.length,
      segment_ids: [],
      exact_text: exact,
      text_sha256: sha(exact),
    };
  });
  return {
    ...base,
    id: `gen-${requestId}`,
    is_test_data: false,
    title: "Stubbed AI draft from a real fatwa",
    source_ids: [SOURCE],
    spans,
    input_hash: record.content_sha256,
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
      generated_at: "2026-10-06T12:30:00+03:00",
      source_sha256: record.content_sha256,
      glossary_sha256: "a".repeat(64),
      settings: { thinking: "enabled", reasoning_effort: "high", response_format: "json_object", max_tokens: 16384 },
      usage: null,
      latency_ms: 1000,
      note: "Stub used by the browser test; no provider was called.",
      human_edited: false,
      last_human_edit_at: null,
    },
  };
}

async function stubGenerate(page: Page) {
  const seen: Json[] = [];
  await page.route("**/api/drafts/generate", async (route: Route) => {
    const body = route.request().postDataJSON() as Json;
    seen.push(body);
    await route.fulfill({
      json: {
        draft: await realDraft(page, body.request_id),
        request_id: body.request_id,
        valid: true,
        errors: [],
        lesson_hash: "sha256:" + "0".repeat(64),
        status: "draft",
      },
    });
  });
  return seen;
}

test("deep link from a real source → stubbed AI draft → acknowledgment → preview → JSON round trip", async ({ page }, info) => {
  const tag = info.project.name;
  const mobile = tag.startsWith("mobile");
  const openTab = async (name: string) => {
    if (mobile) await page.getByRole("tab", { name }).click();
  };
  await stubHealth(page);
  const seen = await stubGenerate(page);
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/setup?source=${SOURCE}`);
  const preview = page.getByTestId("source-preview");
  await expect(preview).toHaveAttribute("data-source-id", SOURCE);
  await expect(preview).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("source-text")).toContainText("ما معنى (شهادة أن لا إله إلا الله");
  await expect(page.getByTestId("source-text")).toContainText("المقدم: حفظكم الله.");
  await expect(page.getByTestId("source-link")).toHaveAttribute("href", /^https:\/\/binbaz\.org\.sa\/fatwas\/18975\//);
  await expect(page.getByTestId("source-ai-note")).toBeVisible();
  await expect(page.getByTestId("real-sources")).toContainText("موقع الشيخ ابن باز");
  await expect(page.getByTestId("technical-sources")).toContainText("أمثلة تقنية");
  await expect(page.getByTestId("technical-sources")).toContainText("الإحالة والنقل والترجمة");
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${tag}-setup-real-source.png`, fullPage: true });
  expect(seen).toHaveLength(0);

  await page.getByTestId("generate").click();
  await expect(page).toHaveURL(/\/review$/, { timeout: 10000 });
  expect(seen).toHaveLength(1);
  const sources = await (await page.request.get("/api/sources")).json();
  const rec = sources.find((s: Json) => s.id === SOURCE);
  expect(seen[0]).toMatchObject({ source_id: SOURCE, source_version: rec.source_version, source_sha256: rec.content_sha256 });
  expect(rec).toMatchObject({ kind: "fatwa", is_test_data: false, library_record_id: "binbaz-18975", library_collection: "fatwa" });
  await expect(page.getByTestId("origin-panel")).toHaveAttribute("data-origin", "live");
  await expect.poll(() => status(page)).toBe("draft");
  await openTab("الدرس");
  await expect(page.getByTestId("source-card").first()).toContainText("ترجمة آلية (غير مراجعة)");

  await openTab("الإقرار");
  const panel = page.getByTestId("ack-panel");
  await panel.getByLabel("اسمك أو وسمك").fill("G4-B browser test");
  await panel.getByLabel("قارنت هذه النسخة بالمصدر").check();
  await panel.getByRole("button", { name: "أقرّ هذه النسخة" }).click();
  await expect.poll(() => status(page), { timeout: 5000 }).toBe("acknowledged_by_user");
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${tag}-review-acknowledged.png`, fullPage: true });

  await page.goto("/preview");
  await expect(page.getByTestId("ai-draft-banner")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${tag}-preview-ai-draft.png`, fullPage: true });

  const exported = await page.evaluate(async () => {
    const ws = JSON.parse(localStorage.getItem("balligh.workspace.v1") ?? "null");
    const r = await fetch("/api/export/json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: ws.draft, review: ws.review }),
    });
    return { status: r.status, body: await r.text() };
  });
  expect(exported.status).toBe(200);
  const path = `${EVIDENCE}/exports/${tag}-real-source-lesson.json`;
  writeFileSync(path, exported.body, "utf-8");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/setup");
  await page.getByTestId("import-input").first().setInputFiles(path);
  await expect(page).toHaveURL(/\/review$/);
  await expect.poll(() => status(page), { timeout: 5000 }).toBe("draft");
  await expect(page.getByTestId("origin-panel")).toHaveAttribute("data-origin", "live");
});

test("an unsupported or unknown deep link explains why and offers no working Prepare", async ({ page }, info) => {
  await stubHealth(page);
  const seen = await stubGenerate(page);
  for (const id of ["lib-quran-1", "binbaz-3521", "src-unknown"]) {
    await page.goto(`/setup?source=${id}`);
    await expect(page.getByTestId("source-unsupported")).toContainText(id);
    await expect(page.getByTestId("generate")).toBeDisabled();
    await expect(page.getByTestId("source-preview")).toHaveCount(0);
  }
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-setup-unsupported.png`, fullPage: true });
  await page.getByRole("radio", { name: /ما معنى الشهادتين/ }).check();
  await expect(page.getByTestId("source-unsupported")).toHaveCount(0);
  await expect(page.getByTestId("source-preview")).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("generate")).toBeEnabled();
  expect(seen).toHaveLength(0);
});
