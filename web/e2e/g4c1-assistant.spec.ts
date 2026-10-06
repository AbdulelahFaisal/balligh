import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/review/G4-C1/browser");
mkdirSync(OUT, { recursive: true });

const KEYS = ["balligh.workspace.v1", "balligh.progress.v1", "balligh.reading.v1"];
const FATWA_A = "binbaz-11423";
const FATWA_B = "binbaz-2171";
const HADITH = "hadeethenc-65000";

type Body = { request_id: string; mode: string; locale: string; question: string; context: Record<string, unknown> | null };

const stores = (page: Page) => page.evaluate((keys) => keys.map((k) => localStorage.getItem(k)), KEYS);

function reply(b: Body, over: Record<string, unknown> = {}) {
  return {
    request_id: b.request_id,
    mode: b.mode,
    locale: b.locale,
    status: "answered",
    answer_kind: "ai_explanation",
    paragraphs: [{ text: `MOCK ANSWER ${b.mode} ${b.request_id.slice(0, 8)}`, evidence: ["e1"] }],
    evidence: [
      {
        id: "e1",
        kind: b.mode === "site_help" ? "help" : "arabic_original",
        label: "MOCK LABEL",
        text: "نص الدليل المقتبس",
        lang: "ar",
        dir: "rtl",
        href: b.mode === "site_help" ? "/library" : `/library/questions/${FATWA_A}`,
        url: "https://binbaz.org.sa/fatwas/11423",
        source: { title: "MOCK SOURCE", publisher: "MOCK PUBLISHER", sha256: null, version: null, edition: null },
      },
    ],
    scope: { mode: b.mode, title: "MOCK", href: "/library" },
    meta: { model: null, prompt_version: "mock", latency_ms: null, provider_calls: 0, usage: null },
    ...over,
  };
}

async function mockAsk(page: Page) {
  const bodies: Body[] = [];
  const ctl = {
    bodies,
    gate: null as Promise<void> | null,
    release: () => {},
    answer: (b: Body) => ({ status: 200, json: reply(b) as unknown }),
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
    window.history.pushState({ usr: null, key: "g4c1", idx: (window.history.state?.idx ?? 0) + 1 }, "", url);
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  }, to);
}

test("no ask call on load or open; keyboard open, Escape and focus return; site help answer with evidence", async ({ page }, info) => {
  const ask = await mockAsk(page);
  await page.goto("/");
  const launcher = page.getByTestId("assistant-launcher");
  await expect(launcher).toBeVisible();
  await launcher.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(page.getByTestId("assistant-scope")).toHaveAttribute("data-mode", "site_help");
  await expect(page.getByTestId("assistant-scope-source")).toHaveCount(0);
  await expect(page.getByTestId("assistant-send")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(launcher).toBeFocused();
  await page.keyboard.press("Space");
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(300);
  expect(ask.bodies).toHaveLength(0);
  await page.getByTestId("assistant-question").fill("  كيف أحفظ موضع القراءة؟  ");
  await expect(page.getByTestId("assistant-counter")).toContainText("/ 1000");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-paragraph")).toContainText("MOCK ANSWER site_help");
  expect(ask.bodies).toHaveLength(1);
  expect(ask.bodies[0]).toMatchObject({ mode: "site_help", locale: "ar", question: "كيف أحفظ موضع القراءة؟", context: null });
  expect(Object.keys(ask.bodies[0]).sort()).toEqual(["context", "locale", "mode", "question", "request_id"]);
  await expect(page.getByTestId("assistant-ai-label")).toBeVisible();
  const ev = page.getByTestId("assistant-evidence").first();
  await expect(ev).toHaveAttribute("data-kind", "help");
  await expect(ev).toContainText("مساعدة الموقع");
  await expect(ev.locator("blockquote")).toHaveAttribute("lang", "ar");
  await expect(ev.getByTestId("assistant-evidence-url")).toHaveAttribute("rel", /noopener/);
  await page.getByTestId("assistant-cite").first().click();
  await expect(ev).toBeFocused();
  await page.screenshot({ path: `${OUT}/${info.project.name}-site-help.png`, fullPage: false });
  await page.getByTestId("assistant-close").click();
  await expect(dialog).toBeHidden();
  await expect(launcher).toBeFocused();
});

test("fatwa scope sends the loaded record and reading locale once; storage unchanged", async ({ page, request }, info) => {
  const ask = await mockAsk(page);
  await page.goto(`/library/questions/${FATWA_A}?lang=en`);
  await expect(page.getByTestId("fatwa-reader")).toHaveAttribute("data-id", FATWA_A);
  const detail = await (await request.get(`/api/library/fatwas/${FATWA_A}?locale=en`)).json();
  const before = await stores(page);
  await openPanel(page);
  expect(ask.bodies).toHaveLength(0);
  await expect(page.getByTestId("assistant-scope")).toHaveAttribute("data-mode", "fatwa");
  await expect(page.getByTestId("assistant-scope-source")).toBeChecked();
  await expect(page.getByTestId("assistant-locale")).toHaveAttribute("data-locale", "en");
  await page.getByTestId("assistant-question").fill("What is the ruling here?");
  await page.getByTestId("assistant-send").dblclick();
  await expect(page.getByTestId("assistant-paragraph")).toContainText("MOCK ANSWER fatwa");
  await page.waitForTimeout(300);
  expect(ask.bodies).toHaveLength(1);
  expect(ask.bodies[0].locale).toBe("en");
  expect(ask.bodies[0].context).toEqual({
    record_id: detail.record.id,
    sha256: detail.record.content_sha256,
    version: detail.record.schema,
  });
  await page.screenshot({ path: `${OUT}/${info.project.name}-fatwa.png`, fullPage: false });
  await page.getByTestId("assistant-close").click();
  expect(await stores(page)).toEqual(before);
});

test("a late reply after navigating to another record is ignored, and cancel aborts", async ({ page }) => {
  const ask = await mockAsk(page);
  await page.goto(`/library/questions/${FATWA_A}?lang=en`);
  await expect(page.getByTestId("fatwa-reader")).toHaveAttribute("data-id", FATWA_A);
  await openPanel(page);
  ask.hold();
  await page.getByTestId("assistant-question").fill("First question about A");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-sending")).toBeVisible();
  const first = ask.release;
  await navigateInApp(page, `/library/questions/${FATWA_B}?lang=en`);
  await expect(page.getByTestId("fatwa-reader")).toHaveAttribute("data-id", FATWA_B);
  first();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("assistant-answer")).toHaveCount(0);
  await expect(page.getByTestId("assistant-current")).toHaveAttribute("data-state", "cancelled");
  await expect(page.getByTestId("assistant-cancelled")).toHaveAttribute("data-reason", "context");
  ask.hold();
  await page.getByTestId("assistant-question").fill("Question about B");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-cancel")).toBeVisible();
  await page.getByTestId("assistant-cancel").click();
  await expect(page.getByTestId("assistant-cancelled").first()).toHaveAttribute("data-reason", "user");
  await expect(page.getByTestId("assistant-question")).toHaveValue("Question about B");
  ask.release();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("assistant-answer")).toHaveCount(0);
  expect(ask.bodies).toHaveLength(2);
  expect(ask.bodies[0].context?.record_id).toBe(FATWA_A);
  expect(ask.bodies[1].context?.record_id).toBe(FATWA_B);
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-paragraph")).toContainText(`MOCK ANSWER fatwa ${ask.bodies[2]?.request_id.slice(0, 8) ?? ""}`);
  expect(ask.bodies).toHaveLength(3);
  expect(new Set(ask.bodies.map((b) => b.request_id)).size).toBe(3);
});

test("hadith scope context; not_configured shows the message and keeps the question", async ({ page, request }, info) => {
  const ask = await mockAsk(page);
  ask.answer = () => ({ status: 503, json: { detail: { code: "not_configured", message: "assistant disabled", retryable: false } } });
  await page.goto(`/library/hadith/${HADITH}?lang=en`);
  await expect(page.getByTestId("hadith-reader")).toHaveAttribute("data-id", HADITH);
  const detail = await (await request.get(`/api/library/hadith/${HADITH}?locale=en`)).json();
  await openPanel(page);
  await expect(page.getByTestId("assistant-scope")).toHaveAttribute("data-mode", "hadith");
  await page.getByTestId("assistant-question").fill("Explain this hadith");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-error")).toHaveAttribute("data-code", "not_configured");
  await expect(page.getByTestId("assistant-error")).toContainText("المساعد غير مُعدّ على هذا الخادم.");
  await expect(page.getByTestId("assistant-retry")).toHaveCount(0);
  await expect(page.getByTestId("assistant-question")).toHaveValue("Explain this hadith");
  expect(ask.bodies).toHaveLength(1);
  expect(ask.bodies[0]).toMatchObject({ mode: "hadith", locale: "en" });
  expect(ask.bodies[0].context).toEqual({ record_id: detail.record.id, sha256: detail.record.content_sha256, version: detail.record.schema });
  await page.screenshot({ path: `${OUT}/${info.project.name}-not-configured.png`, fullPage: false });
});

test("Quran scope uses the reader's ayah and data, leaves the player and storage unchanged", async ({ page, request }, info) => {
  const ask = await mockAsk(page);
  ask.answer = (b) => ({
    status: 200,
    json: reply(b, {
      status: "quran_extract",
      answer_kind: "published_extract",
      paragraphs: [],
      evidence: [
        { id: "q1", kind: "quran_arabic", label: "78:31", text: "إِنَّ لِلْمُتَّقِينَ مَفَازًا", lang: "ar", dir: "rtl", href: "/library/quran/78?lang=en#ayah-31", url: null, source: { title: "Quran", publisher: null, sha256: null, version: null, edition: null } },
        { id: "q2", kind: "quran_translation", label: "78:31", text: "Indeed, for the righteous is attainment", lang: "en", dir: "ltr", href: null, url: null, source: { title: "Saheeh International", publisher: null, sha256: null, version: null, edition: "Saheeh International" } },
      ],
      scope: { mode: "quran", title: "النبأ", href: "/library/quran/78?lang=en" },
    }),
  });
  await page.goto("/library/quran/78?lang=en");
  await expect(page.getByTestId("surah-body")).toBeVisible();
  const surah = await (await request.get("/api/library/quran/78?locale=en")).json();
  const phase = await page.getByTestId("quran-player").getAttribute("data-phase");
  const ayahSel = await page.getByTestId("audio-ayah").inputValue();
  const before = await stores(page);
  await openPanel(page);
  await expect(page.getByTestId("assistant-scope")).toHaveAttribute("data-mode", "quran");
  await page.getByTestId("assistant-ayah").selectOption("31");
  await expect(page.getByTestId("assistant-scope-title")).toContainText("78:31");
  await page.getByTestId("assistant-question").fill("What does this ayah say?");
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-extract-label")).toBeVisible();
  await expect(page.getByTestId("assistant-tafsir")).toHaveCount(0);
  await expect(page.getByTestId("assistant-quran-note")).toBeVisible();
  expect(ask.bodies).toHaveLength(1);
  expect(ask.bodies[0]).toMatchObject({ mode: "quran", locale: "en" });
  expect(ask.bodies[0].context).toEqual({
    surah: 78,
    ayah: 31,
    sha256: surah.content_sha256,
    version: surah.edition?.version ?? `arabic-${surah.locale}`,
    tafsir: false,
  });
  await page.screenshot({ path: `${OUT}/${info.project.name}-quran.png`, fullPage: false });
  await page.getByTestId("assistant-close").click();
  await expect(page.getByTestId("quran-player")).toHaveAttribute("data-phase", phase ?? "");
  expect(await page.getByTestId("audio-ayah").inputValue()).toBe(ayahSel);
  expect(await page.evaluate(() => [...document.querySelectorAll("audio")].some((a) => !a.paused))).toBe(false);
  expect(await stores(page)).toEqual(before);
});

test("teacher pages offer site help only", async ({ page }) => {
  const ask = await mockAsk(page);
  await page.goto("/setup");
  await openPanel(page);
  await expect(page.getByTestId("assistant-teacher-note")).toBeVisible();
  await expect(page.getByTestId("assistant-scope-source")).toHaveCount(0);
  await expect(page.getByTestId("assistant-scope")).toHaveAttribute("data-mode", "site_help");
  expect(ask.bodies).toHaveLength(0);
});
