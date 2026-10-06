import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/review/G4-V1/screenshots/checks");
mkdirSync(OUT, { recursive: true });

const TAGLINE = "بَلِّغُوا عَنِّي وَلَوْ آيَةً";
const SCREENS = [
  "/",
  "/learn",
  "/library",
  "/library/questions",
  "/library/questions/binbaz-18975?lang=en",
  "/library/hadith/hadeethenc-65000?lang=ur",
  "/library/hadith/hadeethenc-65000?lang=zh-Hans",
  "/library/hadith/hadeethenc-65000?lang=bn",
  "/library/quran/78?lang=en",
  "/setup",
  "/sources",
];

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

function ratio(fg: string, bg: string) {
  const lum = (c: string) => {
    const v = (c.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number);
    const f = (x: number) => {
      const s = x / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(v[0]) + 0.7152 * f(v[1]) + 0.0722 * f(v[2]);
  };
  const [a, b] = [lum(fg), lum(bg)];
  return Math.round((((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100)) / 100;
}

async function colors(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const toRgb = (c: string) => {
      const cv = document.createElement("canvas").getContext("2d")!;
      cv.fillStyle = c;
      cv.fillRect(0, 0, 1, 1);
      const d = cv.getImageData(0, 0, 1, 1).data;
      return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
    };
    let node: Element | null = el;
    let bg = "rgba(0, 0, 0, 0)";
    while (node) {
      const c = getComputedStyle(node).backgroundColor;
      const img = getComputedStyle(node).backgroundImage;
      if (!/rgba\(0, 0, 0, 0\)|transparent/.test(c) || img !== "none") {
        bg = img !== "none" && /gradient/.test(img) ? (img.match(/oklch\([^)]*\)|rgb\([^)]*\)/)?.[0] ?? c) : c;
        break;
      }
      node = node.parentElement;
    }
    return { fg: toRgb(getComputedStyle(el).color), bg: toRgb(bg) };
  });
}

test("integrated screens: tagline, no horizontal overflow, long translations, enlarged text", async ({ page }, info) => {
  const report: Record<string, unknown> = { project: info.project.name };
  for (const url of SCREENS) {
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("brand-tagline")).toHaveText(TAGLINE);
    report[`overflow ${url}`] = await overflow(page);
    expect(await overflow(page), `${url} horizontal overflow`).toBeLessThanOrEqual(1);
  }
  for (const url of ["/library/questions/binbaz-18975?lang=ar", "/library/quran/78?lang=en", "/learn"]) {
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.waitForTimeout(300);
    report[`overflow at 200% root text ${url}`] = await overflow(page);
    expect(await overflow(page), `${url} overflow at 200% root text`).toBeLessThanOrEqual(1);
  }
  writeFileSync(`${OUT}/${info.project.name}-screens.json`, JSON.stringify(report, null, 1) + "\n");
});

test("seven locales: direction, language and destinations; Arabic and English labels", async ({ page }, info) => {
  const seen: Record<string, unknown> = {};
  await page.goto("/learn");
  for (const loc of ["ar", "en", "ur", "zh-Hans", "id", "bn", "fr"]) {
    await page.locator("select.bl-rail-select").selectOption(loc);
    await expect(page.locator("html")).toHaveAttribute("lang", loc);
    const dir = await page.locator("html").getAttribute("dir");
    expect(dir).toBe(loc === "ar" || loc === "ur" ? "rtl" : "ltr");
    await expect(page.locator(".bl-root")).toHaveAttribute("dir", dir!);
    await expect(page.getByTestId("nav-learn")).toBeVisible();
    await expect(page.getByTestId("nav-library")).toBeVisible();
    await expect(page.getByTestId("nav-setup")).toBeVisible();
    expect(await overflow(page), `${loc} overflow`).toBeLessThanOrEqual(1);
    seen[loc] = { dir, learn: await page.getByTestId("nav-learn").innerText() };
    if (loc === "ar" || loc === "en" || loc === "ur") await page.screenshot({ path: `${OUT}/${info.project.name}-locale-${loc}.png` });
  }
  await page.locator("select.bl-rail-select").selectOption("ar");
  writeFileSync(`${OUT}/${info.project.name}-locales.json`, JSON.stringify(seen, null, 1) + "\n");
});

test("keyboard, visible focus, reduced motion and contrast spot checks", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/library");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "التنقل الرئيسي" })).toBeFocused();
  const brand = page.getByTestId("brand");
  await brand.focus();
  await expect(brand).toBeFocused();
  const outline = await brand.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");
  for (const id of ["nav-learn", "nav-library", "nav-setup"]) {
    await page.getByTestId(id).focus();
    await expect(page.getByTestId(id)).toBeFocused();
  }
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/setup$/);
  const duration = await page.getByTestId("nav-learn").evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(duration.split(",").every((d) => parseFloat(d) === 0)).toBe(true);
  await page.goto("/learn");
  const checks: Record<string, number> = {};
  const pairs: [string, string][] = [
    ["rail link (inactive)", "[data-testid=nav-library]"],
    ["rail link (current)", "[data-testid=nav-learn]"],
    ["tagline on teal", "[data-testid=brand-tagline]"],
    ["page heading", "main h1"],
    ["primary button", "main .bl-btn--primary"],
  ];
  for (const [name, sel] of pairs) {
    if ((await page.locator(sel).count()) === 0) continue;
    const c = await colors(page, sel);
    checks[name] = ratio(c.fg, c.bg);
  }
  await page.goto("/library/questions/binbaz-18975?lang=ar");
  await page.waitForLoadState("networkidle");
  const body = await colors(page, "main p");
  checks["reader paragraph"] = ratio(body.fg, body.bg);
  for (const [name, value] of Object.entries(checks)) expect(value, name).toBeGreaterThanOrEqual(4.5);
  writeFileSync(`${OUT}/${info.project.name}-contrast.json`, JSON.stringify(checks, null, 1) + "\n");
});
