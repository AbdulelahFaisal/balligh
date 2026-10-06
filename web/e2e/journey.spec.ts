import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const openAuthor = async (page: Page) => {
  if (!new URL(page.url()).pathname.endsWith("/preview")) return;
  await page.getByTestId("import-input").waitFor({ state: "attached" });
  const d = page.getByTestId("author-toolbar");
  if ((await d.count()) === 0) return;
  if ((await d.getAttribute("open")) === null) await d.locator("summary").click();
};

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = resolve(HERE, "../../docs/review/G4-B-P1");
mkdirSync(`${EVIDENCE}/screenshots`, { recursive: true });
const MALICIOUS = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>"'><a href="javascript:window.__pwned=3">x</a> data:text/html,<b>x</b>`;

async function status(page: Page) {
  return page.getByTestId("review-status").first().getAttribute("data-status");
}

async function expectStatus(page: Page, s: string) {
  await expect.poll(() => status(page), { timeout: 5000 }).toBe(s);
}

test("source → edit → acknowledge → preview → export → import", async ({ page, context }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });

  await page.route("**/api/health", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.generation = { ...body.generation, enabled: false, configured: false };
    await route.fulfill({ response: res, json: body });
  });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "التنقل الرئيسي" })).toBeFocused();

  await page.getByRole("button", { name: "جهّز درسًا" }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByTestId("library-toggle").click(); // G5-B: the library choice sits behind the pasted-text form
  await expect(page.getByRole("button", { name: "ولّد مسودة" })).toBeDisabled();
  await page.getByTestId("source-option-src-g1-local-note-ar").getByRole("radio").check();
  await page.getByRole("button", { name: "افتح المسودة الاختبارية" }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expectStatus(page, "draft");

  const openTab = async (name: string) => {
    if (mobile) await page.getByRole("tab", { name }).click();
  };

  await openTab("الأصل");
  await expect(page.getByTestId("original-text")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("original-text")).toContainText("الإحالة إلى المصدر");
  await openTab("الدرس");
  const card1 = page.getByTestId("card-text-card-1");
  await card1.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Always.");
  await expect(card1).toHaveValue(/Always\.$/);
  await expect(page.getByTestId("source-card").first()).toContainText("مرجع محلي");
  await expect(page.getByTestId("source-card").first().locator("a")).toHaveCount(0);

  await page.getByTestId("card-note-card-2").fill(MALICIOUS);

  await openTab("الإقرار");
  const panel = page.getByTestId("ack-panel");
  await panel.getByLabel("اسمك أو وسمك").fill("مختبر G1 — Tester");
  await panel.getByLabel("قارنت هذه النسخة بالمصدر").check();
  await panel.getByRole("button", { name: "أقرّ هذه النسخة" }).click();
  await expectStatus(page, "acknowledged_by_user");
  await expect(panel).toContainText("أقرها المستخدم");

  await openTab("الدرس");
  await page.getByTestId("activity-question").fill("Changed question?");
  await openTab("الإقرار");
  await expectStatus(page, "stale");
  await openTab("الدرس");
  await page
    .getByTestId("activity-question")
    .fill("According to the source, what should happen before a translation is published?");
  await openTab("الإقرار");
  await expectStatus(page, "acknowledged_by_user");

  await openTab("الدرس");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-review.png` });

  await page.goto("/preview");
  await expectStatus(page, "acknowledged_by_user");
  await page.getByRole("button", { name: "تكبير النص" }).click();
  await page.waitForTimeout(600);
  await expectStatus(page, "acknowledged_by_user");
  await expect(page.getByTestId("lesson")).toHaveAttribute("dir", "ltr");
  await expect(page.getByTestId("lesson").locator("blockquote").first()).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("lesson")).toContainText("<script>");
  expect(await page.locator("main img").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await expect(page.getByRole("button", { name: "استمع" }).first()).toBeDisabled();

  await page.getByLabel("It should be published right away.").check();
  await page.getByRole("button", { name: "جرّب فهمك" }).click();
  await expect(page.getByTestId("activity-feedback")).toContainText("ليست هذه");
  await page.getByRole("button", { name: "حاول مجددًا" }).click();
  await page.getByLabel("Someone fluent in both languages should review it.").check();
  await page.getByRole("button", { name: "جرّب فهمك" }).click();
  await expect(page.getByTestId("activity-feedback")).toContainText("إجابة صحيحة");
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-preview-activity.png` });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${EVIDENCE}/screenshots/${info.project.name}-preview.png` });

  const tag = info.project.name;
  mkdirSync(`${EVIDENCE}/exports`, { recursive: true });
  const htmlPath = `${EVIDENCE}/exports/${tag}-server-payload-lesson.html`;
  const jsonPath = `${EVIDENCE}/exports/${tag}-server-payload-lesson.json`;
  const capture = async (kind: "html" | "json", label: string, path: string) => {
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/export/${kind}`)),
      page.getByRole("button", { name: label }).click(),
    ]);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"]).toContain(`balligh-lesson.${kind}`);
    const body = await page.evaluate(async (k) => {
      const ws = JSON.parse(localStorage.getItem("balligh.workspace.v1") ?? "null");
      const r = await fetch(`/api/export/${k}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: ws.draft, review: ws.review }),
      });
      return r.text();
    }, kind);
    writeFileSync(path, body, "utf-8");
  };
  await openAuthor(page);
  await capture("html", "صدّر HTML", htmlPath);
  await openAuthor(page);
  await capture("json", "صدّر JSON", jsonPath);
  const html = readFileSync(htmlPath, "utf-8");
  expect(html.toLowerCase()).not.toContain("<script");
  expect(html).not.toMatch(/<img/i);
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("أقرها المستخدم");
  const envelope = JSON.parse(readFileSync(jsonPath, "utf-8"));
  expect(envelope.status_at_export).toBe("acknowledged_by_user");

  const offline = await context.newPage();
  offline.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await offline.goto(pathToFileURL(htmlPath).href);
  await expect(offline.locator("h1")).toContainText("Test lesson");
  await expect(offline.locator("blockquote").first()).toHaveAttribute("dir", "rtl");
  expect(await offline.locator("img, script, iframe").count()).toBe(0);
  expect(await offline.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await offline.close();

  const tampered = { ...envelope, team_approved: true, status: "approved" };
  const tamperedPath = `${EVIDENCE}/exports/${tag}-tampered-import.json`;
  writeFileSync(tamperedPath, JSON.stringify(tampered));
  await openAuthor(page);
  await page.getByRole("button", { name: "امسح العمل المحلي" }).click();
  await expect(page.getByText("لا يوجد درس مفتوح")).toBeVisible();
  await page.getByTestId("import-input").setInputFiles(tamperedPath);
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByRole("status")).toContainText("تم تجاهله");
  await expectStatus(page, "draft");
  await openTab("الدرس");
  await expect(page.getByTestId("card-note-card-2")).toHaveValue(MALICIOUS);
  await expect(page.getByTestId("card-text-card-1")).toHaveValue(/Always\.$/);

  const corruptPath = `${EVIDENCE}/exports/${tag}-corrupt.json`;
  writeFileSync(corruptPath, "{ not json");
  await page.goto("/preview");
  await page.getByTestId("import-input").setInputFiles(corruptPath);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("lesson")).toContainText("Always.");

  await page.reload();
  await expect(page.getByTestId("lesson")).toContainText("Always.");

  const select = page.getByLabel("لغة الواجهة");
  await select.selectOption("ur");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ur");
  await page.locator("header select").selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByTestId("lesson").locator("blockquote").first()).toHaveAttribute("dir", "rtl");
  for (const loc of ["zh-Hans", "id", "bn", "fr"]) {
    await page.locator("header select").selectOption(loc);
    await expect(page.locator("html")).toHaveAttribute("lang", loc);
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  }
  await page.locator("header select").selectOption("ar");

  await page.goto("/sources");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("المصادر والحدود");
  await expect(page.locator("table tbody tr")).toHaveCount(7);

  for (const path of ["/", "/setup", "/review", "/preview", "/sources"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
  }

  expect(dialogs).toEqual([]);
});
