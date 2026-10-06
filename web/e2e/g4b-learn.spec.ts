import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../../docs/review/G4-B-P2/screenshots");
mkdirSync(SHOTS, { recursive: true });

const shot = (page: Page, project: string, name: string) =>
  page.screenshot({ path: `${SHOTS}/${project}-G4B-${name}.png`, fullPage: false });
const mainNav = (page: Page) => page.getByRole("navigation", { name: "التنقل الرئيسي" });
const READING_KEY = "balligh.reading.v1";

const lessonKeys = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      Object.keys(localStorage)
        .filter((k) => k.startsWith("balligh.") && k !== "balligh.reading.v1")
        .sort()
        .map((k) => [k, localStorage.getItem(k)]),
    ),
  );

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
});

test("three primary destinations; teacher steps only inside the teacher journey; old URLs still work", async ({ page }, info) => {
  await page.goto("/");
  const nav = mainNav(page);
  await expect(nav.getByRole("link")).toHaveText(["تعلّم", "المكتبة", "إعداد درس"]);
  await expect(page.getByTestId("teacher-steps")).toHaveCount(0);
  await expect(page.getByTestId("nav-sources")).toHaveText("المصادر والحدود");
  await expect(page.getByTestId("coverage-line")).toContainText("سبع لغات");
  await expect(page.getByTestId("home-start-learning")).toBeInViewport();
  await shot(page, info.project.name, "home");
  for (const [path, index] of [["/setup", 0], ["/review", 1], ["/preview", 2]] as const) {
    await page.goto(path);
    const steps = page.getByTestId("teacher-steps");
    await expect(steps).toBeVisible();
    await expect(steps.locator('[aria-current="step"]')).toHaveCount(1);
    await expect(steps.getByRole("link").nth(index)).toHaveAttribute("aria-current", "step");
    await expect(nav.getByRole("link", { name: "إعداد درس" })).toHaveAttribute("aria-current", "page");
  }
  for (const path of ["/library", "/library/quran", "/library/questions", "/library/hadith", "/learn", "/sources"]) {
    await page.goto(path);
    await expect(page.getByTestId("teacher-steps")).toHaveCount(0);
  }
  await page.goto("/library/questions/binbaz-2171");
  await expect(page.getByTestId("item-title")).toBeVisible();
  await expect(nav.getByRole("link", { name: "المكتبة" })).toHaveAttribute("aria-current", "page");
});

test("Start learning opens the first real reader and Next follows the stage order", async ({ page }, info) => {
  const manifest = await (await page.request.get("/api/learn")).json();
  const steps = manifest.first_steps as { source_id: string; href: string }[];
  expect(steps.length).toBeGreaterThan(3);
  for (const id of ["binbaz-1157", "binbaz-1263", "binbaz-1998", "binbaz-2171", "binbaz-2554", "binbaz-5629", "binbaz-11643", "binbaz-1655", "binbaz-2089", "binbaz-2460", "binbaz-2994", "binbaz-1524"])
    expect(steps.map((s) => s.source_id)).not.toContain(id);
  // G5-B: the five-stage path is the single visible journey; the old first-steps list is no longer rendered.
  const path = (await (await page.request.get("/api/learn/stages")).json()) as { stages: { order: number; entries: { href: string }[] }[] };
  const s1 = path.stages[0].entries;
  await page.goto("/learn");
  await expect(page.getByTestId("first-step")).toHaveCount(0);
  await expect(page.getByTestId("continue")).toHaveCount(0);
  await expect(page.getByTestId("stage-start-link")).toBeInViewport();
  await shot(page, info.project.name, "learn");
  await page.getByTestId("stage-start-link").click();
  await expect(page).toHaveURL(new RegExp(`${s1[0].href}\\?`));
  await expect(page.getByTestId("stage-position")).toContainText(`1 من ${s1.length}`);
  await page.getByTestId("stage-next-link").click();
  await expect(page).toHaveURL(new RegExp(`${s1[1].href}\\?`));
  await expect(page.getByTestId("item-title")).toBeVisible();
  await expect(page.getByTestId("stage-position")).toContainText(`2 من ${s1.length}`);
  await shot(page, info.project.name, "reader-step2");
  const last = path.stages[path.stages.length - 1];
  await page.goto(`${last.entries[last.entries.length - 1].href}?path=introductory-reading&stage=${last.order}&entry=${last.entries.length}`);
  await expect(page.getByTestId("stage-end-link")).toBeVisible();
  await expect(page.getByTestId("stage-next-link")).toHaveCount(0);
});

test("Continue is offered only for a saved location that validates against the current source", async ({ page }) => {
  await page.goto("/library/questions/binbaz-11423");
  await expect(page.getByTestId("item-title")).toBeVisible();
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), READING_KEY)).not.toBeNull();
  await page.goto("/learn");
  await expect(page.getByTestId("continue-link")).toBeVisible();
  await page.getByTestId("continue-link").click();
  await expect(page).toHaveURL(/\/library\/questions\/binbaz-11423\?lang=ar#fatwa-question$/);

  await page.evaluate((k) => {
    const v = JSON.parse(localStorage.getItem(k)!);
    v.last.sha256 = "sha256:" + "0".repeat(64);
    localStorage.setItem(k, JSON.stringify(v));
  }, READING_KEY);
  await page.goto("/learn");
  await expect(page.getByTestId("continue-stale")).toBeVisible();
  await expect(page.getByTestId("continue")).toHaveCount(0);

  await page.evaluate((k) => localStorage.setItem(k, "{not valid"), READING_KEY);
  await page.goto("/learn");
  await expect(page.getByTestId("reading-notice")).toHaveAttribute("data-notice", "malformed");
  await expect(page.getByTestId("continue")).toHaveCount(0);
  await page.getByTestId("stage-start-link").click();
  await page.getByTestId("stage-next-link").click();
  await expect(page.getByTestId("item-title")).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), READING_KEY)).toBe("{not valid");
});

test("teacher-context classification is visible in the list and reader; full text and links stay", async ({ page }, info) => {
  for (const id of ["binbaz-2171", "binbaz-1655"]) {
    await page.goto(`/library/questions/${id}`);
    const notice = page.getByTestId("teacher-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("data-classification", "teacher_context");
    await expect(page.getByTestId("fatwa-answer")).not.toBeEmpty();
    await expect(page.getByTestId("credit")).toBeVisible();
  }
  await shot(page, info.project.name, "reader-teacher");
  let found = false;
  for (let p = 1; p <= 6 && !found; p++) {
    await page.goto(`/library/questions${p > 1 ? `?page=${p}` : ""}`);
    await expect(page.getByTestId("item-link").first()).toBeVisible();
    const row = page.locator('[data-testid="item-link"][data-id="binbaz-2171"]');
    if ((await row.count()) === 1) {
      await expect(row.getByTestId("teacher-badge")).toHaveText("سياق المعلّم");
      await row.scrollIntoViewIfNeeded();
      await shot(page, info.project.name, "library-list");
      found = true;
    }
  }
  expect(found).toBe(true);
  await page.goto("/library/questions/binbaz-11423");
  await expect(page.getByTestId("item-title")).toBeVisible();
  await expect(page.getByTestId("teacher-notice")).toHaveCount(0);
});

test("Prepare a lesson appears only for records registered as lesson sources", async ({ page }) => {
  const sources = (await (await page.request.get("/api/sources")).json()) as { id: string; library_record_id?: string }[];
  const mapped = sources.find((s) => s.library_record_id === "binbaz-18975");
  expect(mapped).toBeTruthy();
  await page.goto("/library/questions/binbaz-18975");
  await expect(page.getByTestId("prepare-lesson")).toHaveAttribute("href", `/setup?source=${mapped!.id}`);
  await page.goto("/library/questions/binbaz-11423");
  await expect(page.getByTestId("item-title")).toBeVisible();
  await expect(page.getByTestId("prepare-unavailable")).toBeVisible();
  await expect(page.getByTestId("prepare-lesson")).toHaveCount(0);

  await page.route("**/api/sources", (route) =>
    route.fulfill({ json: [{ ...sources[0], id: "lib-mock-11423", library_record_id: "binbaz-11423" }] }),
  );
  await page.goto("/library/questions/binbaz-11423");
  await expect(page.getByTestId("prepare-lesson")).toHaveAttribute("href", "/setup?source=lib-mock-11423");
  await page.goto("/library/questions/binbaz-18975");
  await expect(page.getByTestId("item-title")).toBeVisible();
  await expect(page.getByTestId("prepare-unavailable")).toBeVisible();
});

test("RTL and LTR interface languages, keyboard navigation and reduced motion", async ({ page }) => {
  await page.goto("/learn");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.locator("header select").selectOption("ur");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ur");
  await expect(page.getByTestId("nav-learn")).toHaveText("سیکھیں");
  await page.locator("header select").selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByTestId("nav-learn")).toHaveText("Learn");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Start learning");
  await expect(page.getByTestId("stage-entry").filter({ hasText: "Arabic only" }).first()).toBeVisible();

  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveAttribute("href", "#main");
  let reached = false;
  for (let i = 0; i < 8 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = (await page.locator(":focus").getAttribute("data-testid")) === "nav-learn";
  }
  expect(reached).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/learn$/);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  const duration = await page.getByTestId("nav-learn").evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(duration.split(",").every((d) => parseFloat(d) === 0)).toBe(true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.reload();
  const normal = await page.getByTestId("nav-learn").evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(normal.split(",").some((d) => parseFloat(d) > 0)).toBe(true);
});

test("learning and library visits leave an open lesson, its acknowledgment and progress byte-identical", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  await page.goto("/");
  await page.getByRole("button", { name: "جرّب درسًا" }).click();
  await expect(page).toHaveURL(/\/preview$/);
  await page.getByTestId("teacher-steps").getByRole("link", { name: "المراجعة" }).click();
  if (mobile) await page.getByRole("tab", { name: "الإقرار" }).click();
  const panel = page.getByTestId("ack-panel");
  await panel.getByLabel("اسمك أو وسمك").fill("G4-B learner tester");
  await panel.getByLabel("قارنت هذه النسخة بالمصدر").check();
  await panel.getByRole("button", { name: "أقرّ هذه النسخة" }).click();
  await expect.poll(() => page.getByTestId("review-status").first().getAttribute("data-status")).toBe("acknowledged_by_user");
  await page.getByTestId("teacher-steps").getByRole("link", { name: "الدرس" }).click();
  await page.getByTestId("mark-read").click();
  await page.waitForTimeout(400);
  const progressText = await page.getByTestId("progress-count").innerText();
  const before = await lessonKeys(page);
  expect(before["balligh.workspace.v1"]).toBeTruthy();
  expect(before["balligh.progress.v1"]).toBeTruthy();

  await mainNav(page).getByRole("link", { name: "تعلّم" }).click();
  await page.getByTestId("stage-start-link").click();
  await page.getByTestId("stage-next-link").click();
  await expect(page.getByTestId("item-title")).toBeVisible();
  await page.goto("/library/questions/binbaz-2171");
  await expect(page.getByTestId("teacher-notice")).toBeVisible();
  await page.goto("/library/hadith");
  await expect(page.getByTestId("item-link").first()).toBeVisible();
  await page.getByTestId("item-link").first().click();
  await expect(page.getByTestId("item-title")).toBeVisible();
  await page.goto("/learn");
  await expect(page.getByTestId("continue-link")).toBeVisible();
  expect(await lessonKeys(page)).toEqual(before);

  await mainNav(page).getByRole("link", { name: "إعداد درس" }).click();
  await page.getByTestId("teacher-steps").getByRole("link", { name: "الدرس" }).click();
  await expect(page.getByTestId("lesson")).toBeVisible();
  await expect(page.getByTestId("progress-count")).toHaveText(progressText);
  await expect(page.getByTestId("review-status").first()).toHaveAttribute("data-status", "acknowledged_by_user");
  expect(await lessonKeys(page)).toEqual(before);
});
