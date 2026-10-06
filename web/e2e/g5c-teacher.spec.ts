import { expect, test, type Page, type Route } from "@playwright/test";

type Json = Record<string, any>;
const TEXT_KEY = "balligh.teacherText.v1";

async function stubHealth(page: Page) {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        status: "ok",
        version: "stub",
        sources_loaded: 4,
        generation: { enabled: true, configured: true, provider: "deepseek", model: "deepseek-v4-pro", locales: ["en", "ur", "zh-Hans", "id", "bn", "fr"], max_in_flight: 2, in_flight: 0 },
        provider_audio: { enabled: false, planned_phase: "G4" },
        product_model: "deepseek-v4-pro",
      },
    }),
  );
}

function teacherDraft(base: Json, body: Json): Json {
  const snap = body.teacher_source as Json;
  const sid = snap.id as string;
  return {
    ...base,
    id: `gen-${body.request_id}`,
    is_test_data: false,
    title: "Stubbed lesson",
    source_ids: [sid],
    input_hash: snap.content_sha256,
    target_locale: body.target_locale,
    spans: base.spans.map((s: Json) => ({ ...s, source_id: sid, source_version: snap.version, source_sha256: snap.content_sha256 })),
    terms: base.terms.map((t: Json) => ({ ...t, source_ids: [sid] })),
    teacher_source: snap,
    generation: {
      origin: "live", provider: "deepseek", requested_model: "deepseek-v4-pro", returned_model: "deepseek-v4-pro", prompt_version: "g4b-lesson-2",
      request_id: body.request_id, generated_at: "2026-10-06T21:00:00+03:00", source_sha256: snap.content_sha256, glossary_sha256: "a".repeat(64),
      settings: { thinking: "enabled", reasoning_effort: "high", response_format: "json_object", max_tokens: 16384 },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1, reasoning_tokens: 0 },
      latency_ms: 1000, note: "Stub used by the browser test; no provider was called.", human_edited: false, last_human_edit_at: null,
    },
  };
}

async function setup(page: Page, failFirst = false) {
  await stubHealth(page);
  const base = (await (await page.request.get("/api/examples/g1-citation-lesson-en")).json()).draft;
  const text = (await (await page.request.get("/api/sources/src-g1-local-note-ar")).json()).text as string;
  const seen: Json[] = [];
  await page.route("**/api/drafts/generate", async (route: Route) => {
    const body = route.request().postDataJSON() as Json;
    seen.push(body);
    if (failFirst && seen.length === 1)
      return route.fulfill({ status: 503, json: { detail: { code: "provider_busy", message: "busy", retryable: true } } });
    await route.fulfill({ json: { draft: teacherDraft(base, body), request_id: body.request_id, valid: true, errors: [], lesson_hash: "sha256:" + "0".repeat(64), status: "draft" } });
  });
  return { text, seen };
}

test("G5B-R01: editing text, language, title or reference hides an old confirmation; confirming sends what the form shows", async ({ page }) => {
  const { text, seen } = await setup(page);
  await page.goto("/");
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto("/setup");
  await page.getByTestId("teacher-text").fill(text);
  await page.getByTestId("teacher-create").click();
  await expect(page).toHaveURL(/\/review$/);
  expect(seen).toHaveLength(1);

  await page.goto("/setup");
  const confirm = page.getByTestId("gen-confirm");
  await page.getByTestId("teacher-text").fill(text + " نص ب.");
  await page.getByTestId("teacher-create").click();
  await expect(confirm).toBeVisible();
  await page.getByTestId("teacher-text").fill(text + " نص ج.");
  await expect(confirm).toHaveCount(0);
  await page.getByTestId("teacher-create").click();
  await expect(confirm).toBeVisible();
  await page.getByTestId("teacher-locale").selectOption("ur");
  await expect(confirm).toHaveCount(0);
  await page.getByTestId("teacher-create").click();
  await expect(confirm).toBeVisible();
  await page.getByTestId("teacher-title").fill("عنوان جديد");
  await expect(confirm).toHaveCount(0);
  await page.getByTestId("teacher-more").locator("summary").click();
  await page.getByTestId("teacher-create").click();
  await expect(confirm).toBeVisible();
  await page.getByTestId("teacher-reference").fill("مرجع آخر");
  await expect(confirm).toHaveCount(0);
  expect(seen).toHaveLength(1);

  await page.getByTestId("teacher-create").click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button").first().click();
  await expect(page).toHaveURL(/\/review$/);
  expect(seen).toHaveLength(2);
  expect(seen[1].teacher_source.text).toBe(text + " نص ج.");
  expect(seen[1].teacher_source.title).toBe("عنوان جديد");
  expect(seen[1].teacher_source.declared_reference).toBe("مرجع آخر");
  expect(seen[1].target_locale).toBe("ur");
});

test("G5B-R01: an edit after a failure hides the old Retry", async ({ page }) => {
  const { text, seen } = await setup(page, true);
  await page.goto("/");
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto("/setup");
  await page.getByTestId("teacher-text").fill(text);
  await page.getByTestId("teacher-create").click();
  const failed = page.getByTestId("gen-failed");
  await expect(failed).toBeVisible();
  await page.getByTestId("teacher-title").fill("تغيير");
  await expect(failed).toHaveCount(0);
  expect(seen).toHaveLength(1);
});

for (const [name, seed] of [
  ["a read that throws", null],
  ["malformed saved text", "{not json"],
] as const) {
  test(`G5B-R03: ${name} keeps the earlier bytes until the teacher chooses`, async ({ page }) => {
    await page.addInitScript(
      ([key, seed]) => {
        if (!sessionStorage.getItem("g5c-seeded")) {
          sessionStorage.setItem("g5c-seeded", "1");
          sessionStorage.setItem(key, seed ?? JSON.stringify({ text: "نص سابق لم يُرسل", title: "", reference: "" }));
        }
        if (seed === null) {
          const original = Storage.prototype.getItem;
          Storage.prototype.getItem = function (k: string) {
            if (k === key) throw new Error("blocked");
            return original.call(this, k);
          };
        }
      },
      [TEXT_KEY, seed] as const,
    );
    await page.goto("/setup");
    const notice = page.getByTestId("teacher-store-notice");
    await expect(notice).toHaveAttribute("data-state", seed === null ? "unreadable" : "corrupt");
    const raw = () => page.evaluate((k) => sessionStorage[k] as string | undefined, TEXT_KEY);
    const before = await raw();
    expect(before).toBeTruthy();
    await page.getByTestId("teacher-text").fill("نص جديد");
    await page.waitForTimeout(300);
    expect(await raw()).toBe(before);
    await page.getByTestId("teacher-store-discard").click();
    await expect(notice).toHaveCount(0);
    await expect.poll(raw).toContain("نص جديد");
    await expect(page.getByTestId("teacher-text")).toHaveValue("نص جديد");
  });
}

test("G5B-R03: a failed save keeps the text on screen and says so", async ({ page }) => {
  await page.addInitScript((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k === key) throw new Error("quota");
      return original.call(this, k, v);
    };
  }, TEXT_KEY);
  await page.goto("/setup");
  await page.getByTestId("teacher-text").fill("نص لن يُحفظ");
  await expect(page.getByTestId("teacher-store-notice")).toHaveAttribute("data-state", "write_failed");
  await expect(page.getByTestId("teacher-text")).toHaveValue("نص لن يُحفظ");
});
