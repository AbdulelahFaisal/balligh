import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/review/G4-B-P1/usability");
mkdirSync(OUT, { recursive: true });

const READERS = [
  { name: "quran-78", path: "/library/quran/78?lang=en" },
  { name: "fatwa-18975", path: "/library/questions/binbaz-18975?lang=en" },
  { name: "hadith-65000", path: "/library/hadith/hadeethenc-65000?lang=en" },
];

const contrast = (page: Page, testId: string) =>
  page.getByTestId(testId).first().evaluate((el) => {
    const parse = (c: string) => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    let node: Element | null = el;
    let bg = "rgba(0, 0, 0, 0)";
    while (node) {
      const c = getComputedStyle(node).backgroundColor;
      if (!/rgba\(0, 0, 0, 0\)|transparent/.test(c)) {
        bg = c;
        break;
      }
      node = node.parentElement;
    }
    const fg = lum(parse(getComputedStyle(el).color));
    const back = lum(parse(bg === "rgba(0, 0, 0, 0)" ? "rgb(255,255,255)" : bg));
    const [hi, lo] = fg > back ? [fg, back] : [back, fg];
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  });

test("changed readers at 200% text size: no horizontal page scroll, controls reachable by keyboard, contrast measured", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const report: Record<string, unknown> = { project: info.project.name, reducedMotion: true, textZoom: "200%" };
  for (const reader of READERS) {
    await page.goto(reader.path);
    await expect(page.getByTestId("save-place").first()).toBeVisible({ timeout: 15000 });
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${reader.name}: horizontal overflow at 200%`).toBeLessThanOrEqual(1);
    const button = page.getByTestId("save-place").first();
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("save-place-status").first()).toBeVisible();
    const ratio = await contrast(page, "save-place");
    expect(ratio, `${reader.name}: save-place contrast`).toBeGreaterThanOrEqual(4.5);
    report[reader.name] = { overflowPx: overflow, savePlaceContrast: ratio };
    await page.screenshot({ path: `${OUT}/${info.project.name}-${reader.name}-zoom200.png`, fullPage: false });
  }
  writeFileSync(`${OUT}/${info.project.name}-usability.json`, JSON.stringify(report, null, 1) + "\n");
});
