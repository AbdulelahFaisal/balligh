import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/review/G4-C1-P1/browser");
mkdirSync(OUT, { recursive: true });

const FATWA_A = "binbaz-11423";
const FATWA_B = "binbaz-2171";
const BUSY = { status: 503, json: { detail: { code: "busy", message: "busy", retryable: true } } as unknown };

type Body = { request_id: string; mode: string; locale: string; question: string; context: Record<string, unknown> | null };

function reply(b: Body) {
  return {
    request_id: b.request_id,
    mode: b.mode,
    locale: b.locale,
    status: "answered",
    answer_kind: "ai_explanation",
    paragraphs: [{ text: `MOCK ANSWER ${b.request_id.slice(0, 8)}`, evidence: ["e1"] }],
    evidence: [
      {
        id: "e1", kind: "arabic_original", label: "MOCK", text: "نص", lang: "ar", dir: "rtl", href: null, url: null,
        source: { title: "MOCK", publisher: null, sha256: null, version: null, edition: null },
      },
    ],
    scope: { mode: b.mode, title: "MOCK", href: null },
    meta: { model: null, prompt_version: "mock", latency_ms: null, provider_calls: 0, usage: null },
  };
}

async function mockAsk(page: Page) {
  const bodies: Body[] = [];
  const ctl = {
    bodies,
    gate: null as Promise<void> | null,
    release: () => {},
    answer: (b: Body): { status: number; json: unknown } => ({ status: 200, json: reply(b) }),
    hold() {
      this.gate = new Promise<void>((r) => (this.release = r));
    },
  };
  await page.route("**/api/assistant/ask", async (route: Route) => {
    const body = route.request().postDataJSON() as Body;
    bodies.push(body);
    const gate = ctl.gate;
    ctl.gate = null;
    if (gate) await gate;
    const out = ctl.answer(body);
    try {
      await route.fulfill({ status: out.status, contentType: "application/json", body: JSON.stringify(out.json) });
    } catch {
    }
  });
  return ctl;
}

async function openPanel(page: Page) {
  await page.getByTestId("assistant-launcher").click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function navigateInApp(page: Page, to: string) {
  await page.evaluate((url) => {
    window.history.pushState({ usr: null, key: "c1p1", idx: (window.history.state?.idx ?? 0) + 1 }, "", url);
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  }, to);
}

const box = (page: Page) => page.getByTestId("assistant-question");

test("R01: a reply to an earlier question keeps newer unsent text; unchanged input clears; error and cancel keep text", async ({ page }, info) => {
  const ask = await mockAsk(page);
  await page.goto(`/library/questions/${FATWA_A}?lang=en`);
  await expect(page.getByTestId("fatwa-reader")).toHaveAttribute("data-id", FATWA_A);
  await openPanel(page);
  ask.hold();
  await box(page).fill("Question A");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-sending")).toBeVisible();
  await box(page).fill("Unsent question B");
  ask.release();
  await expect(page.getByTestId("assistant-current")).toHaveAttribute("data-state", "answered");
  await expect(box(page)).toHaveValue("Unsent question B");
  await page.screenshot({ path: `${OUT}/${info.project.name}-r01-kept.png`, fullPage: false });
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-current")).toContainText("Unsent question B");
  await expect(page.getByTestId("assistant-current")).toHaveAttribute("data-state", "answered");
  await expect(box(page)).toHaveValue("");
  ask.answer = () => BUSY;
  await box(page).fill("Question C");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-error").first()).toBeVisible();
  await expect(box(page)).toHaveValue("Question C");
  ask.hold();
  await page.getByTestId("assistant-send").click();
  await page.getByTestId("assistant-cancel").click();
  await expect(page.getByTestId("assistant-cancelled").first()).toHaveAttribute("data-reason", "user");
  await expect(box(page)).toHaveValue("Question C");
  ask.release();
});

test("R02: same-context retry sends once with a fresh id; an old retry is refused after the record or reading language changes", async ({ page }, info) => {
  const ask = await mockAsk(page);
  ask.answer = () => BUSY;
  await page.goto(`/library/questions/${FATWA_A}?lang=en`);
  await expect(page.getByTestId("fatwa-reader")).toHaveAttribute("data-id", FATWA_A);
  await openPanel(page);
  await box(page).fill("Question about A");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-current").getByTestId("assistant-retry")).toBeVisible();
  ask.hold();
  ask.answer = (b) => ({ status: 200, json: reply(b) });
  await box(page).fill("Unsent draft");
  await page.getByTestId("assistant-current").getByTestId("assistant-retry").dblclick();
  ask.release();
  await expect(page.getByTestId("assistant-current")).toHaveAttribute("data-state", "answered");
  expect(ask.bodies).toHaveLength(2);
  expect(ask.bodies[1].request_id).not.toBe(ask.bodies[0].request_id);
  expect(ask.bodies[1].question).toBe("Question about A");
  expect(ask.bodies[1].context).toEqual(ask.bodies[0].context);
  expect(ask.bodies[1].locale).toBe(ask.bodies[0].locale);
  await expect(box(page)).toHaveValue("Unsent draft");

  ask.answer = () => BUSY;
  await box(page).fill("Second question about A");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-current").getByTestId("assistant-retry")).toBeVisible();
  await box(page).fill("Newer unsent text");
  await navigateInApp(page, `/library/questions/${FATWA_B}?lang=en`);
  await expect(page.getByTestId("fatwa-reader")).toHaveAttribute("data-id", FATWA_B);
  await expect(page.getByTestId("assistant-retry")).toHaveCount(0);
  await expect(page.getByTestId("assistant-retry-stale").first()).toBeVisible();
  await expect(box(page)).toHaveValue("Newer unsent text");
  await page.screenshot({ path: `${OUT}/${info.project.name}-r02-record.png`, fullPage: false });
  const sent = ask.bodies.length;

  await box(page).fill("Question about B");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-current").getByTestId("assistant-retry")).toBeVisible();
  await navigateInApp(page, `/library/questions/${FATWA_B}?lang=ur`);
  await expect(page.getByTestId("assistant-retry")).toHaveCount(0);
  await expect(page.getByTestId("assistant-retry-stale").first()).toBeVisible();
  expect(ask.bodies).toHaveLength(sent + 1);
  expect(ask.bodies.every((b) => b.context?.record_id !== FATWA_A || b.question.includes("about A"))).toBe(true);
  expect(ask.bodies.filter((b) => b.context?.record_id === FATWA_B).every((b) => !b.question.includes("about A"))).toBe(true);
});

test("R02: an old Quran retry is refused after the selected ayah changes", async ({ page }) => {
  const ask = await mockAsk(page);
  ask.answer = () => BUSY;
  await page.goto("/library/quran/78?lang=en");
  await expect(page.getByTestId("surah-body")).toBeVisible();
  await openPanel(page);
  await page.getByTestId("assistant-ayah").selectOption("31");
  await box(page).fill("About 78:31");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-current").getByTestId("assistant-retry")).toBeVisible();
  await page.getByTestId("assistant-ayah").selectOption("30");
  await expect(page.getByTestId("assistant-retry")).toHaveCount(0);
  await expect(page.getByTestId("assistant-retry-stale").first()).toBeVisible();
  await page.getByTestId("assistant-ayah").selectOption("31");
  await expect(page.getByTestId("assistant-current").getByTestId("assistant-retry")).toBeVisible();
  expect(ask.bodies).toHaveLength(1);
});

test("D01: a real keyless Quran request from the panel returns the stored extract with zero provider calls", async ({ page, request }, info) => {
  const surah = await (await request.get("/api/library/quran/78?locale=en")).json();
  const ayah = surah.ayahs.find((a: { aya: number }) => a.aya === 31);
  await page.goto("/library/quran/78?lang=en");
  await expect(page.getByTestId("surah-body")).toBeVisible();
  await openPanel(page);
  await page.getByTestId("assistant-ayah").selectOption("31");
  await box(page).fill("What does this ayah say?");
  const plain = page.waitForResponse((r) => r.url().endsWith("/api/assistant/ask"));
  await page.getByTestId("assistant-send").click();
  const res = await plain;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON().context).toMatchObject({ surah: 78, ayah: 31, tafsir: false });
  const json = await res.json();
  const ev = Object.fromEntries(json.evidence.map((e: { id: string }) => [e.id, e]));
  expect(json.meta.provider_calls).toBe(0);
  expect(ev.qa.text).toBe(ayah.arabic.trim());
  expect(ev.qt.text).toBe(ayah.translation.trim());
  expect(ev.qm).toBeUndefined();
  await expect(page.getByTestId("assistant-extract-label")).toBeVisible();
  await expect(page.getByTestId("assistant-tafsir")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toContainText(ayah.arabic.trim());
  await page.screenshot({ path: `${OUT}/${info.project.name}-d01-quran.png`, fullPage: false });
  await page.goto("/library/quran/78?lang=en&tafsir=1");
  await expect(page.getByTestId("tafsir-toggle")).toBeChecked();
  await expect(page.getByTestId("surah-body")).toBeVisible();
  const withTafsir = await (await request.get("/api/library/quran/78?locale=en&tafsir=arabic_moyassar")).json();
  const ayahT = withTafsir.ayahs.find((a: { aya: number }) => a.aya === 31);
  await openPanel(page);
  await page.getByTestId("assistant-ayah").selectOption("31");
  await box(page).fill("And with the tafsir?");
  const tafsir = page.waitForResponse((r) => r.url().endsWith("/api/assistant/ask"));
  await page.getByTestId("assistant-send").click();
  const res2 = await tafsir;
  expect(res2.request().postDataJSON().context).toMatchObject({ surah: 78, ayah: 31, tafsir: true });
  const json2 = await res2.json();
  const ev2 = Object.fromEntries(json2.evidence.map((e: { id: string }) => [e.id, e]));
  expect(json2.meta.provider_calls).toBe(0);
  expect(ev2.qm.text).toBe(ayahT.tafsir.trim());
  await expect(page.getByTestId("assistant-tafsir")).toBeVisible();
});
