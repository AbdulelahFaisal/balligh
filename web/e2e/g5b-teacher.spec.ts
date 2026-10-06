import { expect, test, type Page, type Route } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/review/G5-B/teacher");
mkdirSync(OUT, { recursive: true });
const KEY = "balligh.workspace.v1";
type Json = Record<string, any>;

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

/** A draft over the teacher's own text: the example lesson's spans are exact ranges of the same text. */
function teacherDraft(base: Json, body: Json): Json {
  const snap = body.teacher_source as Json;
  const sid = snap.id as string;
  return {
    ...base,
    id: `gen-${body.request_id}`,
    is_test_data: false,
    title: "Stubbed lesson from the teacher's text",
    source_ids: [sid],
    input_hash: snap.content_sha256,
    target_locale: body.target_locale,
    spans: base.spans.map((s: Json) => ({ ...s, source_id: sid, source_version: snap.version, source_sha256: snap.content_sha256 })),
    terms: base.terms.map((t: Json) => ({ ...t, source_ids: [sid] })),
    cards: base.cards.map((c: Json) => ({ ...c, derivation: c.kind === "quote" ? "machine_translation" : "machine_explanation" })),
    teacher_source: snap,
    generation: {
      origin: "live",
      provider: "deepseek",
      requested_model: "deepseek-v4-pro",
      returned_model: "deepseek-v4-pro",
      prompt_version: "g4b-lesson-2",
      request_id: body.request_id,
      generated_at: "2026-10-06T21:00:00+03:00",
      source_sha256: snap.content_sha256,
      glossary_sha256: "a".repeat(64),
      settings: { thinking: "enabled", reasoning_effort: "high", response_format: "json_object", max_tokens: 16384 },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1, reasoning_tokens: 0 },
      latency_ms: 1000,
      note: "Stub used by the browser test; no provider was called.",
      human_edited: false,
      last_human_edit_at: null,
    },
  };
}

async function stubGenerate(page: Page, base: Json) {
  const seen: Json[] = [];
  await page.route("**/api/drafts/generate", async (route: Route) => {
    const body = route.request().postDataJSON() as Json;
    seen.push(body);
    await route.fulfill({
      json: { draft: teacherDraft(base, body), request_id: body.request_id, valid: true, errors: [], lesson_hash: "sha256:" + "0".repeat(64), status: "draft" },
    });
  });
  return seen;
}

async function setUi(page: Page, lang: "ar" | "en") {
  await page.locator("header select, select.bl-rail-select").first().selectOption(lang);
  await expect(page.locator("html")).toHaveAttribute("lang", lang);
}

async function prepare(page: Page, locale: string, title = "") {
  await stubHealth(page);
  const base = (await (await page.request.get("/api/examples/g1-citation-lesson-en")).json()).draft;
  const text = (await (await page.request.get("/api/sources/src-g1-local-note-ar")).json()).text as string;
  const seen = await stubGenerate(page, base);
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto("/setup");
  await expect(page.getByTestId("teacher-prepare")).toBeVisible();
  await expect(page.getByTestId("source-option-src-g1-local-note-ar")).toHaveCount(0);
  await page.getByTestId("teacher-text").fill(text);
  await expect(page.getByTestId("teacher-count")).toContainText("300");
  if (title) await page.getByTestId("teacher-title").fill(title);
  await page.getByTestId("teacher-locale").selectOption(locale);
  await page.getByTestId("teacher-create").click();
  await expect(page).toHaveURL(/\/review$/, { timeout: 15000 });
  return { text, seen };
}

test("pasted Arabic text becomes a reviewable lesson that keeps its own source through export and re-import", async ({ page }, info) => {
  const { text, seen } = await prepare(page, "en");
  expect(seen).toHaveLength(1);
  expect(seen[0].target_locale).toBe("en");
  expect(seen[0].teacher_source.text).toBe(text);
  expect(seen[0].source_id).toBe(seen[0].teacher_source.id);
  expect(seen[0].source_id).toMatch(/^teacher-[0-9a-f]{16}$/);
  await expect(page.getByTestId("review-status").first()).toHaveAttribute("data-status", "draft");
  if (info.project.name.startsWith("mobile")) await page.getByRole("tab", { name: "الأصل" }).click().catch(() => undefined);
  const original = page.getByTestId("original");
  await expect(original).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("original-text")).toContainText(text.slice(0, 20));
  await expect(original.getByTestId("teacher-source-label")).toBeVisible();
  await expect(page.getByTestId("original-technical")).not.toHaveAttribute("open", "");
  await page.screenshot({ path: `${OUT}/${info.project.name}-review.png` });

  await page.goto("/preview");
  await expect(page.getByTestId("teacher-source-label").first()).toBeAttached();
  await page.screenshot({ path: `${OUT}/${info.project.name}-preview.png` });

  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), KEY);
  expect(stored.draft.teacher_source.text).toBe(text);
  const exported = await page.request.post("/api/export/json", { data: { draft: stored.draft, review: null } });
  expect(exported.status()).toBe(200);
  const file = info.outputPath("teacher-lesson.json");
  writeFileSync(file, JSON.stringify(await exported.json()));
  await page.evaluate(() => localStorage.clear());
  await page.goto("/preview");
  await page.getByTestId("import-input").setInputFiles(file);
  await page.waitForFunction((k) => (localStorage.getItem(k) ?? "").includes('"teacher_source"'), KEY);
  await page.goto("/review");
  await expect(page.getByTestId("review-status").first()).toHaveAttribute("data-status", "draft");
  if (info.project.name.startsWith("mobile")) await page.getByRole("tab", { name: "الأصل" }).click().catch(() => undefined);
  await expect(page.getByTestId("original")).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("original-text")).toContainText(text.slice(0, 20));
  const sources = await (await page.request.get("/api/sources")).json();
  expect(sources.some((s: Json) => s.id === seen[0].source_id)).toBe(false);
});

test("an Urdu lesson keeps the learner language and its right-to-left direction", async ({ page }) => {
  const { seen } = await prepare(page, "ur");
  expect(seen[0].target_locale).toBe("ur");
  await page.goto("/preview");
  await expect(page.getByTestId("lesson")).toHaveAttribute("dir", "rtl");
});

test("an empty or non-Arabic text is refused with the input kept", async ({ page }) => {
  await stubHealth(page);
  await page.goto("/setup");
  await page.getByTestId("teacher-create").click();
  await expect(page.getByTestId("teacher-error")).toBeVisible();
  await page.getByTestId("teacher-text").fill("This is English only.");
  await page.getByTestId("teacher-create").click();
  await expect(page.getByTestId("teacher-error")).toBeVisible();
  await expect(page.getByTestId("teacher-text")).toHaveValue("This is English only.");
  await page.getByTestId("library-toggle").click();
  await expect(page.getByTestId("generate")).toBeVisible();
});

test("G5-N02: every character of a long original source stays visible at 1440, 1000 and 390 in both directions", async ({ page }, info) => {
  test.setTimeout(180_000);
  const longTitle = "عنوان-طويل-جدا-بلا-مسافات-".repeat(6);
  await prepare(page, "en", longTitle);
  const report: Json[] = [];
  for (const lang of ["ar", "en"] as const) {
    for (const [w, h] of [[1440, 900], [1000, 800], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/review");
      await setUi(page, lang);
      if (w < 1024) await page.getByRole("tab", { name: lang === "ar" ? "الأصل" : "Original" }).click().catch(() => undefined);
      const panel = page.getByTestId("original");
      await expect(panel).toHaveAttribute("data-state", "ready");
      const result = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-testid="original"]')!;
        const bad: string[] = [];
        let chars = 0;
        for (const target of Array.from(el.querySelectorAll<HTMLElement>('[data-testid="original-text"], [data-testid="original-meta"]'))) {
          const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const s = n.textContent ?? "";
            for (let i = 0; i < s.length; i++) {
              if (!s[i].trim()) continue;
              const r = document.createRange();
              r.setStart(n, i);
              r.setEnd(n, i + 1);
              const rect = r.getBoundingClientRect();
              if (rect.width < 1 || rect.height < 1) continue;
              const mid = rect.top + rect.height / 2;
              if (mid < innerHeight * 0.2 || mid > innerHeight * 0.8) window.scrollBy(0, mid - innerHeight / 2);
              const q = r.getBoundingClientRect();
              const x = q.left + q.width / 2;
              const y = q.top + q.height / 2;
              chars++;
              const hit = x >= 0 && x < innerWidth && y >= 0 && y < innerHeight ? document.elementFromPoint(x, y) : null;
              if (!hit || !el.contains(hit)) bad.push(`${s[i]}@${Math.round(x)},${Math.round(y)}`);
            }
          }
        }
        return { chars, bad: bad.slice(0, 10), overflow: document.documentElement.scrollWidth - innerWidth };
      });
      report.push({ lang, width: w, ...result });
      await page.screenshot({ path: `${OUT}/${info.project.name}-n02-${lang}-${w}.png` });
      expect(result.chars).toBeGreaterThan(50);
      expect(result.bad, `${lang} ${w}`).toEqual([]);
    }
  }
  writeFileSync(`${OUT}/${info.project.name}-n02-geometry.json`, JSON.stringify(report, null, 1));
});

test("sha256 helper sanity for fixtures", () => {
  expect(createHash("sha256").update("x").digest("hex")).toHaveLength(64);
});
