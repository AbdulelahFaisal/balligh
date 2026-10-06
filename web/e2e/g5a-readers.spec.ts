import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/review/G5-A/readers");
mkdirSync(OUT, { recursive: true });

const FATWA = "/library/questions/binbaz-2171";
const HADITH = "/library/hadith/hadeethenc-2945";
const READING_KEY = "balligh.reading.v1";

type Row = { tag: string; testid: string | null; text: string; color: string; background: string; ratio: number };

const measure = (page: Page) =>
  page.getByTestId("quran-player").evaluate((root): { strip: string; stripRgb: number[]; rows: Row[] } => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const cx = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgba = (css: string): number[] => {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = "#000";
      cx.fillStyle = css;
      cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const blend = (top: number[], alpha: number, bottom: number[]) => [0, 1, 2].map((i) => top[i] * alpha + bottom[i] * (1 - alpha));
    const background = (el: Element): number[] => {
      const layers: number[][] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = rgba(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] >= 1) break;
      }
      let base = [255, 255, 255];
      for (const c of layers.reverse()) base = blend(c, c[3], base);
      return base;
    };
    const opacity = (el: Element) => {
      let o = 1;
      for (let e: Element | null = el; e && e !== root.parentElement; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      return o;
    };
    const lum = (c: number[]) => {
      const f = (v: number) => {
        const x = v / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const rows: Row[] = [];
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (el.closest("option")) continue;
      const own = el.tagName === "SELECT" || [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "");
      if (!own) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || (el as HTMLElement).offsetParent === null) continue;
      const bg = background(el);
      const fgRaw = rgba(cs.color);
      const fg = blend(fgRaw, fgRaw[3] * opacity(el), bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      rows.push({
        tag: el.tagName.toLowerCase(),
        testid: el.getAttribute("data-testid") ?? el.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
        text: (el.tagName === "SELECT" ? (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? "" : el.textContent ?? "").trim().slice(0, 48),
        color: cs.color,
        background: `rgb(${bg.map((v) => Math.round(v)).join(", ")})`,
        ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
      });
    }
    const strip = getComputedStyle(root).backgroundColor;
    return { strip, stripRgb: rgba(strip), rows };
  });

test("R02: every text in the Quran player strip measures at least 4.5:1 on the rendered strip", async ({ page }, info) => {
  await page.goto("/library/quran/1?lang=en");
  const player = page.getByTestId("quran-player");
  await expect(page.getByTestId("audio-play")).toBeVisible({ timeout: 20000 });
  await player.scrollIntoViewIfNeeded();
  const idle = await measure(page);
  await page.getByTestId("audio-mode-page").check();
  const pageMode = await measure(page);
  const all = [...idle.rows, ...pageMode.rows];
  const heading = idle.rows.find((r) => r.tag === "h2");
  expect(heading, "player heading measured").toBeTruthy();
  expect(all.length).toBeGreaterThan(8);
  for (const r of all) expect(r.ratio, `${r.tag}[${r.testid}] «${r.text}» ${r.color} on ${r.background}`).toBeGreaterThanOrEqual(4.5);
  expect(idle.rows.some((r) => r.tag === "button" && r.testid === "audio-stop")).toBe(true);
  writeFileSync(`${OUT}/${info.project.name}-player-contrast.json`, JSON.stringify({ strip: idle.strip, stripRgb: idle.stripRgb, heading, idle: idle.rows, pageMode: pageMode.rows }, null, 1) + "\n");
  await page.getByTestId("audio-mode-ayah").check();
  await player.screenshot({ path: `${OUT}/${info.project.name}-player.png` });
});

test("fatwa reader: content first, one Source area, one save control that follows the section in view", async ({ page }, info) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${FATWA}?lang=ar`);
  await expect(page.getByTestId("item-title")).toBeVisible();
  const source = page.getByTestId("reader-source");
  await expect(source).toHaveCount(1);
  await expect(source.getByTestId("credit")).toHaveCount(1);
  await expect(page.getByTestId("credit")).toHaveCount(1);
  await expect(source.getByTestId("status-note")).toHaveCount(1);
  await expect(source.getByTestId("tech-details")).not.toHaveAttribute("open", "");
  const order = await page.evaluate(() => {
    const a = document.querySelector("#fatwa-answer")!;
    const s = document.querySelector('[data-testid="reader-source"]')!;
    return Boolean(a.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);
  const save = page.getByTestId("save-place");
  await expect(save).toHaveCount(1);
  await expect(page.getByTestId("reader-save").getByTestId("save-place")).toHaveCount(1);
  await expect(save).toHaveAttribute("data-anchor", "fatwa-question");
  await page.locator("#fatwa-answer").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(save).toHaveAttribute("data-anchor", "fatwa-answer");
  await expect(save).toBeInViewport();
  await save.click();
  await expect(page.getByTestId("save-place-status")).toHaveText("حُفظ موضعك هنا.");
  const stored = JSON.parse((await page.evaluate((k) => localStorage.getItem(k), READING_KEY))!);
  expect(stored.last.anchor).toBe("fatwa-answer");
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(save).toHaveAttribute("data-anchor", "fatwa-question");
  const refs = page.getByTestId("noteref");
  const notes = page.getByTestId("note");
  if ((await notes.count()) > 0) {
    for (const href of await refs.evaluateAll((els) => els.map((e) => e.getAttribute("href")))) {
      expect(await page.locator(href!).count()).toBe(1);
    }
    for (const href of await page.getByTestId("note-back").evaluateAll((els) => els.map((e) => e.getAttribute("href")))) {
      expect(await page.locator(href!).count()).toBe(1);
    }
  }
  await source.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/${info.project.name}-fatwa-source.png`, fullPage: false });
});

test("hadith reader: grade beside its grader, Dorar status only inside technical details, one Source area", async ({ page }, info) => {
  await page.goto(`${HADITH}?lang=en`);
  await expect(page.getByTestId("item-title")).toBeVisible();
  const source = page.getByTestId("reader-source");
  await expect(source).toHaveCount(1);
  const outside = await page.evaluate(
    () => [...document.querySelectorAll('[data-testid="credit"]')].filter((c) => !c.closest('[data-testid="reader-source"]')).length,
  );
  expect(outside).toBe(0);
  await expect(page.getByTestId("hadith-dorar")).toBeHidden();
  await expect(page.getByTestId("tech-details").getByTestId("hadith-dorar")).toHaveCount(1);
  await expect(page.getByText("رفض الموقع طلب أداة الاستيراد")).toHaveCount(0);
  const visibleText = await page.getByTestId("hadith-reader").innerText();
  expect(visibleText).not.toMatch(/\b403\b/);
  const grade = page.getByTestId("hadith-grade");
  if ((await grade.count()) > 0) {
    await expect(page.getByTestId("hadith-grade-line")).toContainText(await grade.innerText());
  }
  await expect(page.getByTestId("hadith-translation")).toHaveAttribute("lang", "en");
  await expect(page.getByTestId("item-original")).toHaveAttribute("lang", "ar");
  const save = page.getByTestId("save-place");
  await expect(save).toHaveCount(1);
  await page.locator("#hadith-explanation").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(save).toHaveAttribute("data-anchor", "hadith-explanation");
  await page.locator("#hadith-text").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(save).toHaveAttribute("data-anchor", "hadith-text");
  await source.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/${info.project.name}-hadith-source.png`, fullPage: false });
  await source.getByTestId("tech-details").locator("summary").click();
  await expect(page.getByTestId("hadith-dorar")).toBeVisible();
  await expect(page.getByTestId("hadith-dorar")).toContainText("dorar.net");
});

test("fatwa without a published translation: note in the reading language and a prefilled, unsent source question", async ({ page }, info) => {
  const asks: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/assistant/ask")) asks.push(r.url());
  });
  await page.goto(`${FATWA}?lang=en`);
  await expect(page.getByTestId("item-title")).toBeVisible();
  const help = page.getByTestId("fatwa-language-help");
  await expect(help).toHaveAttribute("lang", "en");
  await expect(help).toHaveAttribute("dir", "ltr");
  const action = page.getByTestId("fatwa-help-understand");
  await expect(action).toHaveCount(1);
  await action.click();
  await expect(page.getByTestId("assistant-panel")).toBeVisible();
  await expect(page.getByTestId("assistant-scope-source")).toBeChecked();
  await expect(page.getByTestId("assistant-scope")).toHaveAttribute("data-mode", "fatwa");
  const question = page.getByTestId("assistant-question");
  await expect(question).not.toHaveValue("");
  const prefilled = await question.inputValue();
  await page.waitForTimeout(600);
  expect(asks).toHaveLength(0);
  await page.screenshot({ path: `${OUT}/${info.project.name}-fatwa-help-open.png`, fullPage: false });
  await page.keyboard.press("Escape");
  await page.getByTestId("assistant-question").waitFor({ state: "detached" }).catch(() => undefined);
  if ((await page.getByTestId("assistant-panel").count()) === 0) {
    await action.click();
    await expect(page.getByTestId("assistant-question")).toHaveValue(prefilled);
  }
  expect(asks).toHaveLength(0);
});
