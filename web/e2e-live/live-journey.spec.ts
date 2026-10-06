import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/review/G2/live");
const KEY = "balligh.workspace.v1";

type Json = Record<string, any>;

const stored = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), KEY);
const status = (page: Page) => page.getByTestId("review-status").first().getAttribute("data-status");

async function payload(page: Page, kind: "html" | "json"): Promise<string> {
  return page.evaluate(async (k) => {
    const ws = JSON.parse(localStorage.getItem("balligh.workspace.v1") ?? "null");
    const r = await fetch(`/api/export/${k}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: ws.draft, review: ws.review }),
    });
    return r.text();
  }, kind);
}

test("live: Arabic source to English foundational AI draft through the normal UI", async ({ page, context }) => {
  mkdirSync(OUT, { recursive: true });
  const health = await (await page.request.get("/api/health")).json();
  expect(health.generation.configured, "DEEPSEEK_API_KEY must be configured for the live journey").toBe(true);

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/setup");
  await expect(page.getByTestId("source-preview")).toContainText("الإحالة إلى المصدر");
  await page.screenshot({ path: `${OUT}/desktop-1440-live-setup.png` });

  const started = Date.now();
  await page.getByTestId("generate").click();
  await expect(page.getByTestId("gen-running")).toBeVisible();
  await page.screenshot({ path: `${OUT}/desktop-1440-live-generating.png` });
  await Promise.race([
    page.waitForURL(/\/review$/, { timeout: 7 * 60_000 }),
    page.getByTestId("gen-failed").waitFor({ timeout: 7 * 60_000 }),
  ]);
  if (await page.getByTestId("gen-failed").count()) {
    await page.screenshot({ path: `${OUT}/desktop-1440-live-failed.png` });
    throw new Error(`generation failed: ${await page.getByTestId("gen-failed").getAttribute("data-code")}`);
  }
  const elapsedMs = Date.now() - started;

  const first = await stored(page);
  const draft: Json = first.draft;
  expect(draft.generation.origin).toBe("live");
  expect(first.review).toBeNull();
  const source = await (await page.request.get(`/api/sources/${draft.source_ids[0]}`)).json();
  const codePoints = Array.from(source.text as string);
  for (const span of draft.spans) {
    expect(codePoints.slice(span.start_offset, span.end_offset).join("")).toBe(span.exact_text);
  }
  await expect.poll(() => status(page)).toBe("draft");
  for (const card of draft.cards) {
    const quote = draft.spans.find((s: Json) => s.id === card.quote_id);
    await expect(page.getByTestId("lesson-editor").getByText(quote.exact_text, { exact: true }).first()).toBeVisible();
    expect(["machine_translation", "machine_explanation"]).toContain(card.derivation);
  }
  await expect(page.getByTestId("original-text")).toContainText(draft.spans[0].exact_text);
  await expect(page.getByTestId("source-card").first()).toContainText("مرجع محلي");
  await page.screenshot({ path: `${OUT}/desktop-1440-live-review.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "الدرس" }).click();
  await page.screenshot({ path: `${OUT}/mobile-390-live-review.png` });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByTestId("card-note-c2").fill("Technical test note: compared with its source sentence.");
  await expect(page.getByTestId("origin-edited")).toHaveAttribute("data-edited", "true");
  const panel = page.getByTestId("ack-panel");
  await panel.getByLabel("اسمك أو وسمك").fill("Technical test only (not a scholarly review)");
  await panel.getByLabel("قارنت هذه النسخة بالمصدر").check();
  await panel.getByRole("button", { name: "أقرّ هذه النسخة" }).click();
  await expect.poll(() => status(page)).toBe("acknowledged_by_user");
  await page.screenshot({ path: `${OUT}/desktop-1440-live-acknowledged.png` });

  await page.goto("/preview");
  await expect(page.getByTestId("ai-draft-banner")).toBeVisible();
  await expect.poll(() => status(page)).toBe("acknowledged_by_user");
  await page.screenshot({ path: `${OUT}/desktop-1440-live-preview.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${OUT}/mobile-390-live-preview.png` });
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const [kind, label] of [
    ["html", "صدّر HTML"],
    ["json", "صدّر JSON"],
  ] as const) {
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/export/${kind}`)),
      page.getByRole("button", { name: label }).click(),
    ]);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"]).toContain(`balligh-lesson.${kind}`);
    writeFileSync(`${OUT}/live-server-payload-lesson.${kind}`, await payload(page, kind), "utf-8");
  }

  const html = readFileSync(`${OUT}/live-server-payload-lesson.html`, "utf-8");
  expect(html.toLowerCase()).not.toContain("<script");
  expect(html).toContain("AI draft.");
  expect(html).toContain("Machine translation (AI draft, not reviewed by a person)");
  const offline = await context.newPage();
  await offline.goto(pathToFileURL(`${OUT}/live-server-payload-lesson.html`).href);
  await expect(offline.locator("h1")).toHaveText(draft.title);
  await expect(offline.locator("blockquote").first()).toHaveAttribute("dir", "rtl");
  expect(await offline.locator("script, img, iframe").count()).toBe(0);
  await offline.screenshot({ path: `${OUT}/desktop-1440-live-export-offline.png`, fullPage: true });
  await offline.close();

  await page.reload();
  await expect(page.getByTestId("lesson")).toContainText(draft.cards[0].text);
  await page.getByRole("button", { name: "امسح العمل المحلي" }).click();
  await page.getByTestId("import-input").setInputFiles(`${OUT}/live-server-payload-lesson.json`);
  await expect(page).toHaveURL(/\/review$/);
  await expect.poll(() => status(page)).toBe("draft");
  const reimported = await stored(page);
  expect(reimported.review).toBeNull();
  expect(reimported.draft.generation).toMatchObject({
    origin: "live",
    request_id: draft.generation.request_id,
    human_edited: true,
  });
  await page.screenshot({ path: `${OUT}/desktop-1440-live-reimported.png` });

  writeFileSync(
    `${OUT}/live-journey-summary.json`,
    JSON.stringify(
      {
        request_id: draft.generation.request_id,
        source_id: draft.source_ids[0],
        target_locale: draft.target_locale,
        level: draft.level,
        ui_elapsed_ms: elapsedMs,
        server_latency_ms: draft.generation.latency_ms,
        returned_model: draft.generation.returned_model,
        usage: draft.generation.usage,
        title: draft.title,
        cards: draft.cards.map((c: Json) => ({ id: c.id, derivation: c.derivation, spans: c.source_span_ids })),
        terms: draft.terms.map((t: Json) => t.source_form),
        findings: draft.validation_findings,
        acknowledged_as: "technical test only, not a scholarly review",
        reimported_status: "draft",
        exports_are_server_payloads_not_browser_downloads: true,
      },
      null,
      2,
    ),
    "utf-8",
  );
});
