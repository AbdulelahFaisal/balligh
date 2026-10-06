import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = resolve(HERE, "../../docs/review/G5-A/v2fixes");
mkdirSync(EVIDENCE, { recursive: true });

type Json = Record<string, any>;

async function openTestDraft(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/setup");
  await page.getByTestId("library-toggle").click(); // G5-B: the library choice sits behind the pasted-text form
  await page.getByTestId("source-option-src-g1-local-note-ar").getByRole("radio").check();
  await page.getByRole("button", { name: "افتح المسودة الاختبارية" }).click();
  await expect(page).toHaveURL(/\/review$/);
}

async function setUi(page: Page, lang: "ar" | "en") {
  await page.locator("header select").first().selectOption(lang);
  await expect(page.locator("html")).toHaveAttribute("lang", lang);
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
}

async function sourceCoverage(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-testid="card-source-passage"]');
    if (!panel) return { chars: 0, focusables: 0, bad: ["no source panel"] };
    const bad: string[] = [];
    const centre = (rect: DOMRect) => {
      const mid = rect.top + rect.height / 2;
      if (mid < innerHeight * 0.3 || mid > innerHeight * 0.7) {
        window.scrollTo({ top: window.scrollY + mid - innerHeight / 2, behavior: "instant" as ScrollBehavior });
      }
    };
    const probe = (get: () => DOMRect, label: string) => {
      centre(get());
      const rect = get();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? document.elementFromPoint(x, y) : null;
      if (!hit || !panel.contains(hit)) {
        bad.push(`${label} @${Math.round(x)},${Math.round(y)} -> ${hit ? `${hit.tagName}.${hit.className}` : "outside viewport"}`);
      }
    };
    let chars = 0;
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      for (let i = 0; i < text.length; i++) {
        if (!text[i].trim()) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rects = Array.from(range.getClientRects()).filter((r) => r.width >= 1 && r.height >= 1);
        rects.forEach((_, k) => {
          chars++;
          probe(() => range.getClientRects()[k] ?? range.getBoundingClientRect(), JSON.stringify(text[i]));
        });
      }
    }
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>("a[href],button,input,select,textarea,summary,[tabindex]"),
    );
    for (const el of focusables) probe(() => el.getBoundingClientRect(), `focusable ${el.tagName}`);
    const title = panel.querySelector<HTMLElement>(".bl-source__title");
    if (!title) bad.push("no source title");
    return { chars, focusables: focusables.length, bad };
  });
}

async function measureSourcePanel(page: Page, project: string, tag: string, langs: ("ar" | "en")[]) {
  const report: Json[] = [];
  const failures: string[] = [];
  for (const lang of langs) {
    for (const [width, height] of [
      [1440, 900],
      [1000, 800],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto("/preview");
      await setUi(page, lang);
      const panel = page.getByTestId("card-source-passage");
      await expect(panel).toBeVisible();
      await expect(panel.locator(".bl-source__title")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      const lessonDir = await page.getByTestId("lesson").getAttribute("dir");
      const result = await sourceCoverage(page);
      report.push({ project, tag, lang, lessonDir, width, ...result });
      await page.locator(".bl-stage--read").scrollIntoViewIfNeeded();
      await page.locator(".bl-stage--read").screenshot({
        path: `${EVIDENCE}/r01-${tag}-${lang}-${width}-${project}.png`,
        animations: "disabled",
      });
      if (result.chars <= 20) failures.push(`${tag} ${lang} ${width}: only ${result.chars} characters sampled`);
      for (const b of result.bad) failures.push(`${tag} ${lang} ${width}: ${b}`);
    }
  }
  writeFileSync(`${EVIDENCE}/r01-geometry-${tag}-${project}.json`, JSON.stringify(report, null, 2));
  expect(failures.slice(0, 40)).toEqual([]);
}

test("R01 every source-panel character and control on /preview stays uncovered (RTL and LTR UI)", async ({ page }, info) => {
  test.setTimeout(180_000);
  await openTestDraft(page);
  await measureSourcePanel(page, info.project.name, "ltr-lesson", ["ar", "en"]);
});

test("R01 an RTL lesson keeps the source panel uncovered under LTR and RTL UI", async ({ page }, info) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  const res = await page.request.get("/api/examples/g1-citation-lesson-en");
  expect(res.status()).toBe(200);
  const draft: Json = { ...(await res.json()).draft, target_locale: "ur" };
  const check = await page.request.post("/api/drafts/validate", { data: { draft } });
  expect(check.status()).toBe(200);
  expect((await check.json()).valid).toBe(true);
  const file = info.outputPath("rtl-lesson.json");
  writeFileSync(file, JSON.stringify({ format: "balligh.export/1", draft }));
  await page.goto("/preview");
  await page.getByTestId("import-input").setInputFiles(file);
  // Integrator test synchronization: a successful import may move on to /review, and the workspace autosave runs in
  // an effect after it renders. Wait until the imported draft is persisted, then open /preview explicitly.
  await page.waitForFunction(() => (localStorage.getItem("balligh.workspace.v1") ?? "").includes('"target_locale":"ur"'));
  await page.goto("/preview");
  await expect(page.getByTestId("lesson")).toHaveAttribute("dir", "rtl");
  await measureSourcePanel(page, info.project.name, "rtl-lesson", ["en", "ar"]);
});

test("R03 card ids title/terms/activity keep unique outline targets and DOM ids", async ({ page }, info) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  const res = await page.request.get("/api/examples/g1-citation-lesson-en");
  expect(res.status()).toBe(200);
  const draft: Json = (await res.json()).draft;
  const names = ["title", "terms", "activity"];
  expect(draft.cards.length).toBeGreaterThanOrEqual(3);
  const original = JSON.stringify(draft);
  draft.cards = draft.cards.map((c: Json, i: number) => (i < 3 ? { ...c, id: names[i] } : c));
  for (let i = 0; i < 3; i++) {
    expect(original.split(JSON.stringify(`card-${i + 1}`)).length - 1).toBe(1);
  }
  const check = await page.request.post("/api/drafts/validate", { data: { draft } });
  expect(check.status()).toBe(200);
  expect((await check.json()).valid).toBe(true);

  const file = info.outputPath("colliding-ids.json");
  writeFileSync(file, JSON.stringify({ format: "balligh.export/1", draft }));
  await page.goto("/preview");
  await page.getByTestId("import-input").setInputFiles(file);
  await expect(page.getByTestId("lesson")).toBeVisible();
  await expect(page.locator('[data-testid="lesson-card"][data-card-id="title"]')).toHaveCount(1);

  await page.goto("/review");
  const mobile = info.project.name.startsWith("mobile");
  if (mobile) await page.getByRole("tab", { name: "الدرس" }).click();
  await expect(page.getByTestId("lesson-editor")).toBeVisible();

  const dupes = await page.evaluate(() => {
    const seen = new Map<string, number>();
    for (const el of Array.from(document.querySelectorAll("[id]"))) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
    return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  });
  expect(dupes).toEqual([]);

  for (const section of ["title", "terms", "activity"]) {
    await expect(page.getByTestId(`outline-section-${section}`)).toHaveCount(1);
  }
  for (const id of names) {
    const button = page.getByTestId(`outline-card-${id}`);
    await expect(button).toHaveCount(1);
    await expect(button).toHaveAttribute("aria-controls", `rv-item-card-${id}`);
    await button.click();
    const editor = page.locator(`#rv-item-card-${id}`);
    await expect(editor).toBeFocused();
    await expect(editor.getByTestId(`card-text-${id}`)).toHaveCount(1);
    await expect(editor).toHaveAttribute("data-selected", "true");
    await expect(button).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId(`outline-section-${id}`)).not.toHaveAttribute("aria-current", "true");
  }
  for (const section of ["title", "terms", "activity"]) {
    await page.getByTestId(`outline-section-${section}`).click();
    await expect(page.locator(`#rv-item-section-${section}`)).toBeFocused();
    await expect(page.getByTestId(`outline-section-${section}`)).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId(`outline-card-${section}`)).not.toHaveAttribute("aria-current", "true");
  }
  await expect(page.getByTestId("activity-editor")).toHaveAttribute("id", "rv-item-section-activity");
  await expect(page.getByTestId("terms-editor")).toHaveAttribute("id", "rv-item-section-terms");
  const stored = await page.evaluate(() => localStorage.getItem("balligh.workspace.v1") ?? "");
  for (const id of names) expect(stored).toContain(`"id":"${id}"`);
  await page.screenshot({ path: `${EVIDENCE}/r03-review-outline-${info.project.name}.png` });
});
