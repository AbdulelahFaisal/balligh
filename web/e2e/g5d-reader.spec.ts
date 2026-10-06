import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/review/G5-D/reader");
mkdirSync(OUT, { recursive: true });

const ID = "binbaz-1157";
const FATWA = `/library/questions/${ID}`;

type Run = { kind: string; text: string; note?: string; published?: unknown };
type Para = Run[];

const toEn = (paras: Para[]): Para[] =>
  paras.map((p) => p.map((run) => (run.kind === "text" || run.kind === "strong" ? { ...run, text: `EN: ${run.text.slice(0, 40)}` } : { ...run })));

async function stub(page: import("@playwright/test").Page, withMt: boolean) {
  await page.route(`**/api/library/fatwas/${ID}*`, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (withMt) {
      const r = body.record;
      const question = toEn(r.question);
      const answer = toEn(r.answer);
      let tagged = false;
      for (const p of answer)
        for (const run of p)
          if (!tagged && run.kind === "quran") {
            run.published = { surah: 2, ayah: 255, text: "EN-PUBLISHED: Allah - there is no deity except Him", edition: "Test Edition" };
            tagged = true;
          }
      body.machine_translation = {
        locale: "en",
        label: "ai_assisted",
        model: "stub",
        prompt_version: "t1",
        generated_at: "2026-10-06T00:00:00Z",
        title: `EN: ${r.title}`,
        question,
        answer,
        notes: (r.notes ?? []).map((n: { id: string; runs: Run[] }) => ({ id: n.id, paragraphs: toEn([n.runs]) })),
      };
    } else body.machine_translation = null;
    await route.fulfill({ response: res, json: body });
  });
}

test("fatwa reader shows the full AI-assisted translation without any assistant request", async ({ page }, info) => {
  const asks: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/assistant")) asks.push(r.url());
  });
  await stub(page, true);
  await page.goto(`${FATWA}?lang=en`);
  await expect(page.getByTestId("item-title")).toContainText("EN: ");
  await expect(page.getByTestId("mt-label")).toHaveCount(1);
  await expect(page.getByTestId("mt-label")).toHaveText("AI-assisted translation");
  const mt = page.getByTestId("fatwa-mt");
  await expect(mt).toBeVisible();
  await expect(mt).toContainText("EN: ");
  expect(await mt.locator("p").count()).toBeGreaterThan(1);
  await expect(page.getByTestId("translation-unavailable")).toHaveCount(0);
  const disclosure = page.getByTestId("fatwa-original-disclosure");
  await expect(disclosure).toHaveCount(1);
  await expect(page.getByTestId("item-original")).toBeHidden();
  await disclosure.locator("summary").click();
  await expect(page.getByTestId("item-original")).toBeVisible();
  expect(await page.getByTestId("noteref").count()).toBeGreaterThan(0);
  await expect(page.getByTestId("reader-source")).toBeVisible();
  await page.screenshot({ path: `${OUT}/${info.project.name}-mt.png`, fullPage: true });
  expect(asks).toEqual([]);
});

test("fatwa reader keeps the honest unavailable state when machine_translation is null", async ({ page }, info) => {
  await stub(page, false);
  await page.goto(`${FATWA}?lang=en`);
  await expect(page.getByTestId("item-title")).toBeVisible();
  await expect(page.getByTestId("translation-unavailable")).toBeVisible();
  await expect(page.getByTestId("fatwa-language-help")).toBeVisible();
  await expect(page.getByTestId("mt-label")).toHaveCount(0);
  await expect(page.getByTestId("fatwa-original-disclosure")).toHaveCount(0);
  await expect(page.getByTestId("item-original")).toBeVisible();
  await page.screenshot({ path: `${OUT}/${info.project.name}-unavailable.png`, fullPage: false });
});
