import { expect, test, type Page, type Route } from "@playwright/test";
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
const LIVE_FILE = resolve(HERE, "../../server/tests/fixtures/live/g2-live-export-en-f034a415.json");
const WS = "balligh.workspace.v1";
const PROGRESS = "balligh.progress.v1";
mkdirSync(`${EVIDENCE}/screenshots`, { recursive: true });
mkdirSync(`${EVIDENCE}/exports`, { recursive: true });
mkdirSync(`${EVIDENCE}/test-inputs`, { recursive: true });

type Json = Record<string, any>;

const live = (): Json => JSON.parse(readFileSync(LIVE_FILE, "utf8"));
const S2 = live().draft.spans.find((s: Json) => s.id === "s2").exact_text as string;
const MALICIOUS = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>`;
const REPLACE = "استبدل بالملف المستورد";

const status = (page: Page) => page.getByTestId("review-status").first().getAttribute("data-status");
const expectStatus = (page: Page, s: string) => expect.poll(() => status(page), { timeout: 6000 }).toBe(s);
const raw = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);
const stored = async (page: Page) => JSON.parse((await raw(page, WS)) ?? "null");
const shot = (page: Page, project: string, name: string) =>
  page.screenshot({ path: `${EVIDENCE}/screenshots/${project}-G3-${name}.png`, fullPage: true });

function inputFile(name: string, envelope: Json) {
  const path = `${EVIDENCE}/test-inputs/${name}`;
  writeFileSync(path, JSON.stringify(envelope));
  return path;
}

async function delay(page: Page, pattern: string, ms: number) {
  await page.route(pattern, async (route: Route) => {
    await new Promise((r) => setTimeout(r, ms));
    try {
      await route.continue();
    } catch {
      return;
    }
  });
}

const IMPORT = "**/api/drafts/import";

async function holdImport(page: Page) {
  const log: string[] = [];
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => (open = () => r()));
  const handler = async (route: Route) => {
    log.push("request");
    const response = await route.fetch().catch(() => null);
    log.push(response ? `held:${response.status()}` : "held:error");
    await gate;
    log.push("delivered");
    try {
      if (response) await route.fulfill({ response });
      else await route.abort();
    } catch {
      return;
    }
  };
  await page.route(IMPORT, handler);
  return {
    log,
    requests: () => log.filter((e) => e === "request").length,
    release: () => {
      log.push("release");
      open();
    },
    dispose: async () => {
      open();
      await page.unroute(IMPORT, handler);
    },
  };
}

async function openLive(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/preview");
  await page.getByTestId("import-input").setInputFiles(LIVE_FILE);
  await expect(page).toHaveURL(/\/review$/);
  await expectStatus(page, "draft");
}

function tabs(page: Page, mobile: boolean) {
  return async (name: "الأصل" | "الدرس" | "الإقرار") => {
    if (mobile) await page.getByRole("tab", { name }).click();
  };
}

async function acknowledge(page: Page, mobile: boolean) {
  await tabs(page, mobile)("الإقرار");
  const panel = page.getByTestId("ack-panel");
  await panel.getByLabel("اسمك أو وسمك").fill("G3 tester");
  await panel.getByLabel("قارنت هذه النسخة بالمصدر").check();
  await panel.getByRole("button", { name: "أقرّ هذه النسخة" }).click();
  await expectStatus(page, "acknowledged_by_user");
}

async function serverExport(page: Page, kind: "html" | "json") {
  return page.evaluate(
    async ([k, key]) => {
      const ws = JSON.parse(localStorage.getItem(key) ?? "null");
      const r = await fetch(`/api/export/${k}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: ws.draft, review: ws.review }),
      });
      return { status: r.status, body: await r.text() };
    },
    [kind, WS] as const,
  );
}

const nav = (page: Page, name: "المراجعة" | "الدرس") => page.getByRole("navigation", { name: "التنقل الرئيسي" }).getByRole("link", { name, exact: true }).click();

test("review: terms, choices, answer and rationale are editable; edits reach preview and export; blank fields block", async ({
  page,
}, info) => {
  const mobile = info.project.name.startsWith("mobile");
  const tab = tabs(page, mobile);
  await openLive(page);
  await acknowledge(page, mobile);
  const hashBefore = await page.getByTestId("ack-panel").locator("code").innerText();

  await tab("الدرس");
  await expect(page.getByTestId("term-editor-t1").getByTestId("term-source-form")).toHaveText("الإحالة");
  await expect(page.getByTestId("term-editor-t1").locator("input, textarea")).toHaveCount(2);
  await page.getByTestId("term-meaning-t1").fill("Naming where a quotation comes from so readers can check it.");
  await page.getByTestId("term-display-t2").fill("verbatim quotation");
  await page.getByTestId("option-text-d").fill("The name of the work and where the phrase appears in it");
  await page.getByTestId("option-correct-d").check();
  await page.getByTestId("activity-rationale").fill("The source says to name the book or article and the place of the phrase, so readers can check.");
  await expect(page.getByTestId("option-correct-b")).not.toBeChecked();
  await tab("الإقرار");
  await expectStatus(page, "stale");
  await expect(page.getByTestId("ack-panel").locator("code")).not.toHaveText(hashBefore);
  await expect(page.getByTestId("origin-panel")).toHaveAttribute("data-origin", "live");

  await tab("الدرس");
  await page.getByTestId("term-meaning-t3").fill("");
  await page.getByTestId("option-text-a").fill("   ");
  await expect(page.getByTestId("term-meaning-t3")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("option-text-a")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("field-error")).toHaveCount(2);
  await tab("الإقرار");
  await expectStatus(page, "unverified");
  await expect(page.getByTestId("validation-failure")).toContainText("terms.2.meaning");
  await expect(page.getByTestId("ack-panel").getByRole("button", { name: "أقرّ هذه النسخة" })).toBeDisabled();
  await tab("الدرس");
  await page.getByTestId("term-meaning-t3").fill("An effort to carry meaning from one language to another.");
  await tab("الإقرار");
  await expectStatus(page, "needs_correction");
  await expect(page.getByTestId("registry-errors")).toContainText("activity option a text is blank");
  if (!mobile) await page.getByTestId("lesson-editor").getByTestId("activity-editor").scrollIntoViewIfNeeded();
  await tab("الدرس");
  await shot(page, info.project.name, "review-blank-field");
  const blocked = await serverExport(page, "html");
  expect(blocked.status).toBe(422);
  expect(blocked.body).toContain("activity option a text is blank");
  await page.getByTestId("option-text-a").fill("Only the author's name");
  await tab("الإقرار");
  await expectStatus(page, "stale");
  await acknowledge(page, mobile);

  await nav(page, "الدرس");
  await expectStatus(page, "acknowledged_by_user");
  await page.getByTestId("learner-term-t1").getByRole("button").click();
  await expect(page.getByTestId("learner-term-t1")).toContainText("Naming where a quotation comes from");
  await page.getByLabel("The name of the work and where the phrase appears in it").check();
  await page.getByRole("button", { name: "جرّب فهمك" }).click();
  await expect(page.getByTestId("activity-feedback")).toHaveAttribute("data-result", "correct");
  await expect(page.getByTestId("activity-feedback")).toContainText("so readers can check.");

  const html = await serverExport(page, "html");
  expect(html.status).toBe(200);
  expect(html.body).toContain("Naming where a quotation comes from so readers can check it.");
  expect(html.body).toContain("<strong>The name of the work and where the phrase appears in it</strong>");
  expect(html.body).toContain("so readers can check.</p></details>");
  expect(html.body).toContain("Acknowledged by the user — <bdi>G3 tester</bdi>");
});

test("the comparison confirmation is bound to the version; an acknowledgment in flight is pending, single and superseded by an edit", async ({
  page,
}, info) => {
  const mobile = info.project.name.startsWith("mobile");
  const tab = tabs(page, mobile);
  await openLive(page);
  await tab("الإقرار");
  const panel = page.getByTestId("ack-panel");
  await panel.getByLabel("اسمك أو وسمك").fill("G3 tester");
  await panel.getByLabel("دورك (تصريح ذاتي، اختياري)").fill("Arabic–English editor");
  await page.getByTestId("ack-confirm").check();
  await tab("الدرس");
  await page.getByTestId("term-display-t2").fill("verbatim quotation (an-naql)");
  await tab("الإقرار");
  await expect(page.getByTestId("ack-confirm")).not.toBeChecked();
  await expect(page.getByTestId("ack-confirm-reset")).toBeVisible();
  await expect(panel.getByLabel("اسمك أو وسمك")).toHaveValue("G3 tester");
  await expect(panel.getByLabel("دورك (تصريح ذاتي، اختياري)")).toHaveValue("Arabic–English editor");
  await expect(panel.getByRole("button", { name: "أقرّ هذه النسخة" })).toBeDisabled();
  await tab("الدرس");
  await page.getByTestId("term-display-t2").fill(live().draft.terms[1].display_form);
  await tab("الإقرار");
  await page.waitForTimeout(300);
  await expect(page.getByTestId("ack-confirm")).not.toBeChecked();
  await expect(page.getByTestId("ack-confirm-reset")).toBeVisible();

  let ackCalls = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/reviews/acknowledge")) ackCalls += 1;
  });
  await delay(page, "**/api/reviews/acknowledge", 5000);
  await page.getByTestId("ack-confirm").check();
  await expectStatus(page, "draft");
  await panel.getByRole("button", { name: "أقرّ هذه النسخة" }).click();
  const pending = panel.getByRole("button", { name: "جارٍ التسجيل…" });
  await expect(pending).toBeDisabled();
  await expect(page.getByTestId("ack-progress")).toHaveText("جارٍ تسجيل إقرارك…");
  await pending.click({ force: true }).catch(() => undefined);
  await tab("الدرس");
  await page.getByTestId("card-note-c1").fill("Checked against s1 and s2.");
  await tab("الإقرار");
  await expect(page.getByTestId("ack-progress")).toHaveText("جارٍ تسجيل إقرارك…");
  await shot(page, info.project.name, "ack-pending");
  await expect(page.getByTestId("ack-progress")).toContainText("تغيّر الدرس أثناء تسجيل إقرارك", { timeout: 9000 });
  expect(ackCalls).toBe(1);
  await expectStatus(page, "draft");
  expect((await stored(page)).review).toBeNull();
  await expect(page.getByTestId("ack-confirm")).not.toBeChecked();
  await page.unroute("**/api/reviews/acknowledge");

  await page.getByTestId("ack-confirm").check();
  await panel.getByRole("button", { name: "أقرّ هذه النسخة" }).click();
  await expectStatus(page, "acknowledged_by_user");
  await nav(page, "الدرس");
  await page.getByTestId("mark-read").click();
  await page.getByRole("button", { name: "تكبير النص" }).click();
  await page.waitForTimeout(700);
  await expectStatus(page, "acknowledged_by_user");
  await expect(page.getByTestId("mark-read")).toHaveAttribute("aria-pressed", "true");
  expect((await stored(page)).draft.presentation.font_scale).toBe(1.13);
});

test("activity evidence by keyboard highlights exactly s2; terms show source-level references only", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  const tab = tabs(page, mobile);
  await openLive(page);
  await tab("الدرس");
  const evidence = page.getByTestId("activity-evidence").locator("li");
  await expect(evidence).toHaveCount(1);
  await expect(evidence).toHaveAttribute("data-span-id", "s2");
  await expect(evidence.locator("blockquote")).toHaveText(S2);
  await expect(evidence).toContainText("المحارف 44–153");

  const button = page.getByRole("button", { name: "أبرز الدليل في الأصل" });
  await button.focus();
  await page.keyboard.press("Enter");
  if (mobile) await expect(page.getByRole("tab", { name: "الأصل" })).toHaveAttribute("data-state", "active");
  const active = page.locator('[data-testid="original-text"] mark[data-active="true"]');
  await expect(active).toHaveCount(1);
  await expect(active).toHaveAttribute("data-span-id", "s2");
  await expect(active).toHaveText(S2);
  await expect(active).toBeInViewport();
  if (mobile) await expect(active).toBeFocused();
  await expect(page.getByTestId("highlight-status")).toContainText("s2");
  await expect(page.locator('[data-testid="original-text"] mark')).toHaveCount(4);
  await shot(page, info.project.name, "activity-evidence-s2");

  if (mobile) {
    await page.getByRole("button", { name: "ارجع إلى السؤال" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "الدرس" })).toHaveAttribute("data-state", "active");
    await expect(button).toBeFocused();
  }

  for (const id of ["t1", "t2", "t3", "t4"]) {
    const refs = page.getByTestId(`term-editor-${id}`).getByTestId("term-refs");
    await expect(refs).toContainText("إحالة على مستوى المصدر");
    await expect(refs).toContainText("لا إلى جملة بعينها");
    await expect(refs).not.toContainText("المحارف");
  }
  await page.getByTestId("card-text-c3").focus();
  await expect(page.locator('[data-testid="original-text"] mark[data-active="true"]')).toHaveCount(2);
  expect(
    await page.locator('[data-testid="original-text"] mark[data-active="true"]').evaluateAll((m) => m.map((x) => x.getAttribute("data-span-id"))),
  ).toEqual(["s3", "s4"]);
});

test("learner journey: wrong answer, retry, correct answer with evidence; language and font keep it; edits and reset clear only progress", async ({
  page,
}, info) => {
  await openLive(page);
  await nav(page, "الدرس");
  await expect(page.getByTestId("review-notice")).toContainText("معاينة تقنية");
  await expect(page.getByTestId("progress-count")).toHaveText("اكتملت 0 من 3 محطات");
  await expect(page.getByTestId("lesson")).toHaveAttribute("dir", "ltr");
  await expect(page.locator("#st-read")).toHaveAttribute("dir", "rtl");

  const stations = page.getByTestId("station-nav");
  await stations.getByRole("link", { name: /جرّب فهمك/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#st-try")).toBeFocused();

  await page.getByLabel("Only the author's name").check();
  await page.getByRole("button", { name: "جرّب فهمك" }).click();
  const feedback = page.getByTestId("activity-feedback");
  await expect(feedback).toHaveAttribute("data-result", "incorrect");
  await expect(feedback).toContainText("ليست هذه");
  await page.getByTestId("learner-evidence").locator("summary").click();
  await expect(page.getByTestId("learner-evidence").locator("blockquote")).toHaveText(S2);
  await expect(page.getByTestId("progress-st-try")).toContainText("حاولت");
  await shot(page, info.project.name, "learner-wrong-evidence");
  await page.getByRole("button", { name: "حاول مجددًا" }).click();
  await expect(feedback).toHaveCount(0);
  await expect(page.getByLabel("Only the author's name")).not.toBeChecked();
  await page.getByLabel("The book or article name and the place of the phrase").check();
  await page.getByRole("button", { name: "جرّب فهمك" }).click();
  await expect(feedback).toHaveAttribute("data-result", "correct");
  await expect(feedback).toContainText("verify for himself");

  await page.getByTestId("mark-read").click();
  await expect(page.getByTestId("mark-read")).toHaveAttribute("aria-pressed", "true");
  const term = page.getByTestId("learner-term-t2").getByRole("button");
  await expect(term).toHaveAttribute("aria-expanded", "false");
  await term.focus();
  await page.keyboard.press("Enter");
  await expect(term).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("learner-term-t2")).toContainText("Quoting the writer's wording exactly");
  await expect(page.getByTestId("learner-term-t2").getByTestId("term-refs")).toContainText("إحالة على مستوى المصدر");
  await expect(page.getByTestId("progress-count")).toHaveText("أكملت محطات الدرس الثلاث.");
  await expect(page.getByTestId("progress-summary")).toHaveAttribute("data-complete", "true");
  await shot(page, info.project.name, "learner-complete");

  await page.getByRole("button", { name: "تكبير النص" }).click();
  await expect(feedback).toHaveAttribute("data-result", "correct");
  await page.locator("header select").selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(feedback).toContainText("Correct.");
  await expect(page.getByTestId("progress-count")).toHaveText("You have completed the three stations of this lesson.");
  await page.reload();
  await expect(page.getByTestId("progress-count")).toHaveText("You have completed the three stations of this lesson.");
  await expect(page.getByTestId("activity-feedback")).toHaveAttribute("data-result", "correct");
  await page.locator("header select").selectOption("ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  await nav(page, "المراجعة");
  const mobile = info.project.name.startsWith("mobile");
  await tabs(page, mobile)("الدرس");
  await page.getByTestId("option-text-a").fill("Only the name of the author");
  await nav(page, "الدرس");
  await expect(page.getByTestId("activity-feedback")).toHaveCount(0);
  await expect(page.getByTestId("progress-count")).toHaveText("اكتملت 0 من 3 محطات");
  await expect(page.getByLabel("The book or article name and the place of the phrase")).not.toBeChecked();
  expect(JSON.parse((await raw(page, PROGRESS)) ?? "{}")).toMatchObject({ read: false, terms: [], solved: false });

  await page.getByTestId("mark-read").click();
  await page.getByLabel("The book or article name and the place of the phrase").check();
  await page.getByRole("button", { name: "جرّب فهمك" }).click();
  await expect(page.getByTestId("progress-count")).toHaveText("اكتملت 2 من 3 محطات");
  await page.waitForTimeout(400);
  const workspaceBefore = await raw(page, WS);
  const statusBefore = await status(page);
  await page.getByRole("button", { name: "ابدأ التقدّم من جديد" }).click();
  await expect(page.getByTestId("progress-count")).toHaveText("اكتملت 0 من 3 محطات");
  await expect(page.getByTestId("activity-feedback")).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(await raw(page, WS)).toBe(workspaceBefore);
  expect(await status(page)).toBe(statusBefore);
});

test("progress storage failures stay in memory and never touch the lesson or recovery bytes", async ({ page }, info) => {
  await openLive(page);
  await nav(page, "الدرس");
  await page.evaluate((k) => localStorage.setItem(k, "{broken progress"), PROGRESS);
  await page.reload();
  const note = page.getByTestId("progress-storage");
  await expect(note).toHaveAttribute("data-mode", "corrupt");
  const workspaceBefore = await raw(page, WS);
  await page.getByTestId("mark-read").click();
  await expect(page.getByTestId("progress-st-read")).toHaveAttribute("data-done", "true");
  await page.waitForTimeout(400);
  expect(await raw(page, PROGRESS)).toBe("{broken progress");
  expect(await raw(page, WS)).toBe(workspaceBefore);
  await shot(page, info.project.name, "progress-corrupt");
  await page.getByRole("button", { name: "ابدأ التقدّم من جديد" }).click();
  await expect(note).toHaveAttribute("data-mode", "saved");
  await expect.poll(async () => JSON.parse((await raw(page, PROGRESS)) ?? "null")?.read).toBe(false);

  await page.evaluate((k) => localStorage.setItem(k, "{still broken"), WS);
  await page.reload();
  await expect(page.getByTestId("storage-recovery")).toBeVisible();
  await page.goto("/");
  await page.getByRole("button", { name: "جرّب درسًا" }).click();
  await page.getByTestId("mark-read").click();
  await expect(note).toHaveAttribute("data-mode", "saved");
  await page.waitForTimeout(400);
  expect(await raw(page, WS)).toBe("{still broken");
  expect(JSON.parse((await raw(page, PROGRESS)) ?? "null")).toMatchObject({ read: true });
});

for (const failure of ["write", "read"] as const) {
  test(`progress ${failure} failure is reported and the lesson keeps saving`, async ({ page }, info) => {
    await page.addInitScript(
      ([k, mode]) => {
        const proto = Storage.prototype;
        const real = mode === "write" ? proto.setItem : proto.getItem;
        const patched = function (this: Storage, key: string, value?: string) {
          if (key === k) throw new DOMException("blocked", mode === "write" ? "QuotaExceededError" : "SecurityError");
          return (real as (...a: unknown[]) => unknown).call(this, key, value);
        };
        if (mode === "write") proto.setItem = patched as typeof proto.setItem;
        else proto.getItem = patched as typeof proto.getItem;
      },
      [PROGRESS, failure] as const,
    );
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await page.goto("/");
    await page.getByRole("button", { name: "جرّب درسًا" }).click();
    await page.getByTestId("mark-read").click();
    const note = page.getByTestId("progress-storage");
    await expect(note).toHaveAttribute("data-mode", failure === "write" ? "write_failed" : "unavailable");
    await expect(note).toContainText("ما دامت الصفحة مفتوحة فقط");
    await expect(page.getByTestId("progress-st-read")).toHaveAttribute("data-done", "true");
    await expect(page.getByTestId("storage-note")).toBeVisible();
    await expect.poll(async () => (await stored(page))?.draft?.id ?? null).toBe("g1-citation-lesson-en");
    if (failure === "write") await shot(page, info.project.name, "progress-write-failed");
  });
}

test("import replacement: declining keeps everything; a delayed import never overwrites newer work; invalid files change nothing", async ({
  page,
}, info) => {
  const fixture = (await (await page.request.get("/api/examples/g1-citation-lesson-en")).json()).draft;
  const fixtureFile = inputFile("g3-fixture-import.json", { format: "balligh.export/1", draft: fixture });
  const mobile = info.project.name.startsWith("mobile");
  await openLive(page);
  await acknowledge(page, mobile);
  await nav(page, "الدرس");
  await page.getByTestId("mark-read").click();
  await page.waitForTimeout(400);
  const workspaceBefore = await raw(page, WS);
  const progressBefore = await raw(page, PROGRESS);

  await page.getByTestId("import-input").setInputFiles(fixtureFile);
  const confirm = page.getByTestId("import-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("Test lesson");
  await expect(confirm).toContainText("Citing Sources and Keeping Honesty");
  await expect(confirm.getByRole("heading")).toBeFocused();
  await shot(page, info.project.name, "import-confirm");
  await page.getByRole("button", { name: "أبقِ الدرس المفتوح" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("أُلغي الاستيراد");
  expect(await raw(page, WS)).toBe(workspaceBefore);
  expect(await raw(page, PROGRESS)).toBe(progressBefore);
  await expectStatus(page, "acknowledged_by_user");
  await expect(page.getByTestId("mark-read")).toHaveAttribute("aria-pressed", "true");

  const variants: [string, () => Promise<void>, (s: Json) => void][] = [
    [
      "edit",
      async () => {
        await nav(page, "المراجعة");
        await tabs(page, mobile)("الدرس");
        await page.getByLabel("عنوان الدرس").fill("Edited while the import was checked");
      },
      (s) => expect(s.draft.title).toBe("Edited while the import was checked"),
    ],
    [
      "clear",
      async () => {
        await openAuthor(page);
        await page.getByRole("button", { name: "امسح العمل المحلي" }).click();
      },
      (s) => expect(s.draft).toBeNull(),
    ],
    [
      "source switch and font change while opening another draft is disabled",
      async () => {
        await page.getByRole("navigation", { name: "التنقل الرئيسي" }).getByRole("link", { name: "الإعداد" }).click();
        await page.getByTestId("library-toggle").click(); // G5-B: the library choice sits behind the pasted-text form
        await page.getByTestId("source-option-src-g1-local-note-ar").getByRole("radio").check();
        await expect(page.getByRole("button", { name: "افتح المسودة الاختبارية" })).toBeDisabled();
        await nav(page, "الدرس");
        await page.getByRole("button", { name: "تكبير النص" }).click();
      },
      (s) => {
        expect(s.draft.id).toBe(live().draft.id);
        expect(s.draft.presentation.font_scale).toBe(1.13);
      },
    ],
  ];
  const liveFile = inputFile("g3-live-import.json", live());
  for (const [name, act, check] of variants) {
    const sourceAndFont = name.startsWith("source switch");
    await test.step(name, async () => {
      if (sourceAndFont) {
        await page.goto("/preview");
        await page.getByTestId("import-input").setInputFiles(LIVE_FILE);
        if (await page.getByTestId("import-confirm").count()) await page.getByRole("button", { name: REPLACE }).click();
        await expect(page).toHaveURL(/\/review$/);
        await expect
          .poll(async () => {
            const s = await stored(page);
            return { id: s?.draft?.id ?? null, presentation: s?.draft?.presentation ?? null, review: s?.review ?? null };
          })
          .toEqual({ id: live().draft.id, presentation: live().draft.presentation, review: null });
      }
      await page.goto("/preview");
      const held = await holdImport(page);
      try {
        await page.getByTestId("import-input").setInputFiles(sourceAndFont ? liveFile : fixtureFile);
        await expect(page.getByTestId("import-checking")).toBeVisible();
        await expect.poll(() => held.log.filter((e) => e.startsWith("held:")).length).toBe(1);
        expect(held.log).toEqual(["request", "held:200"]);
        await act();
        await expect(async () => check(await stored(page))).toPass({ timeout: 6000 });
        await expect(page.getByText("لم يُطبَّق الاستيراد")).toBeVisible();
        await expect(page.getByTestId("import-checking")).toHaveCount(0);
        await expect(page.getByTestId("import-confirm")).toHaveCount(0);
        const newer = await raw(page, WS);
        const late = page.waitForResponse((r) => r.url().endsWith("/api/drafts/import"));
        held.release();
        expect((await late).status()).toBe(200);
        await (await late).finished();
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        expect(held.log).toEqual(["request", "held:200", "release", "delivered"]);
        await expect(page.getByTestId("import-confirm")).toHaveCount(0);
        await expect(page.getByTestId("import-checking")).toHaveCount(0);
        await expect(page.getByText("لم يُطبَّق الاستيراد")).toBeVisible();
        await expect(page.getByText("تم الاستيراد")).toHaveCount(0);
        await expect(page.getByRole("button", { name: REPLACE })).toHaveCount(0);
        expect(await raw(page, WS)).toBe(newer);
        check(await stored(page));
        expect(held.requests()).toBe(1);
      } finally {
        await held.dispose();
      }
      if (name === "clear") await shot(page, info.project.name, "import-superseded");
    });
  }

  const tampered = live();
  tampered.draft.spans[1].exact_text = "مقطع لا يطابق المصدر";
  const before = await raw(page, WS);
  await page.goto("/preview");
  await page.getByTestId("import-input").setInputFiles(inputFile("g3-tampered-quote.json", tampered));
  await expect(page.getByTestId("error-notice")).toContainText("exact_text does not match");
  await expect(page.getByTestId("import-confirm")).toHaveCount(0);
  expect(await raw(page, WS)).toBe(before);

  await page.getByTestId("import-input").setInputFiles(LIVE_FILE);
  await page.getByRole("button", { name: REPLACE }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expectStatus(page, "draft");
  expect((await stored(page)).draft.id).toBe(live().draft.id);
});

test("export buttons show pending work, send one request, keep structured failures and never claim a saved file", async ({
  page,
}, info) => {
  await openLive(page);
  await nav(page, "الدرس");
  let htmlCalls = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/export/html")) htmlCalls += 1;
  });
  await delay(page, "**/api/export/html", 2000);
  await openAuthor(page);
  await page.getByRole("button", { name: "صدّر HTML" }).click();
  const pending = page.getByRole("button", { name: "جارٍ تجهيز HTML…" });
  await expect(pending).toBeDisabled();
  await pending.click({ force: true }).catch(() => undefined);
  await shot(page, info.project.name, "export-pending");
  await expect(page.getByRole("status")).toContainText("طُلب من المتصفح تنزيله", { timeout: 8000 });
  await expect(page.getByRole("status")).not.toContainText("حُفظ");
  expect(htmlCalls).toBe(1);

  await openAuthor(page);
  await page.getByRole("button", { name: "صدّر HTML" }).click();
  await page.getByRole("button", { name: "تكبير النص" }).click();
  await expect(page.getByRole("status")).toContainText("لم يُنزَّل", { timeout: 8000 });
  await page.unroute("**/api/export/html");

  await page.route("**/api/export/json", (route) =>
    route.fulfill({
      status: 422,
      json: { detail: { message: "draft has validation errors", errors: ["span s2: exact_text does not match the source range"] } },
    }),
  );
  await openAuthor(page);
  await page.getByRole("button", { name: "صدّر JSON" }).click();
  await expect(page.getByTestId("error-notice")).toContainText("draft has validation errors");
  await expect(page.getByTestId("error-notice")).toContainText("span s2: exact_text does not match the source range");
  await openAuthor(page);
  await expect(page.getByRole("button", { name: "صدّر JSON" })).toBeEnabled();
});

test("an acknowledgment that lands while an export is being prepared makes that export ask to be repeated", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  await openLive(page);
  await nav(page, "الدرس");
  await delay(page, "**/api/export/html", 4000);
  await openAuthor(page);
  await page.getByRole("button", { name: "صدّر HTML" }).click();
  await expect(page.getByRole("button", { name: "جارٍ تجهيز HTML…" })).toBeDisabled();
  await nav(page, "المراجعة");
  await acknowledge(page, mobile);
  await expect(page.getByRole("status")).toContainText("لم يُنزَّل", { timeout: 9000 });
  expect((await stored(page)).review).not.toBeNull();
  await page.unroute("**/api/export/html");
  await nav(page, "الدرس");
  await openAuthor(page);
  await expect(page.getByRole("button", { name: "صدّر HTML" })).toBeEnabled();
  const current = await serverExport(page, "html");
  expect(current.body).toContain("Acknowledged by the user — <bdi>G3 tester</bdi>");
});

test("portable HTML works offline with native reveal, carries card, activity and term references, and its JSON re-imports unacknowledged", async ({
  page,
  browser,
}, info) => {
  const mobile = info.project.name.startsWith("mobile");
  await openLive(page);
  await tabs(page, mobile)("الدرس");
  await page.getByTestId("term-meaning-t1").fill("Pointing to where a quotation comes from, so readers can check it.");
  await page.getByTestId("card-note-c2").fill(MALICIOUS);
  await acknowledge(page, mobile);
  const tag = info.project.name;
  const html = await serverExport(page, "html");
  const json = await serverExport(page, "json");
  expect(html.status).toBe(200);
  expect(json.status).toBe(200);
  const htmlPath = `${EVIDENCE}/exports/${tag}-G3-lesson.html`;
  const jsonPath = `${EVIDENCE}/exports/${tag}-G3-lesson.json`;
  writeFileSync(htmlPath, html.body, "utf-8");
  writeFileSync(jsonPath, json.body, "utf-8");
  expect(html.body.toLowerCase()).not.toContain("<script");
  expect(html.body).toContain("&lt;script&gt;");

  const offline = await browser.newContext({ offline: true, viewport: page.viewportSize() ?? undefined });
  const view = await offline.newPage();
  const requests: string[] = [];
  view.on("request", (r) => requests.push(r.url()));
  await view.goto(pathToFileURL(htmlPath).href);
  await expect(view.locator("h1")).toHaveText("Citing Sources and Keeping Honesty");
  await expect(view.getByText("1. Read")).toBeVisible();
  await expect(view.locator("blockquote").first()).toHaveAttribute("dir", "rtl");
  const term = view.locator("details.term").first();
  await expect(term.getByText("Pointing to where a quotation comes from")).toBeHidden();
  await term.locator("summary").focus();
  await view.keyboard.press("Enter");
  await expect(term.getByText("Pointing to where a quotation comes from")).toBeVisible();
  await expect(term).toContainText("Source-level reference");
  const answer = view.locator("details", { has: view.locator("summary", { hasText: "Show answer" }) });
  await expect(answer.locator("strong")).toBeHidden();
  await answer.locator("summary").click();
  await expect(answer.locator("strong")).toHaveText("The book or article name and the place of the phrase");
  const proof = view.locator("details", { has: view.locator("summary", { hasText: "Show the evidence" }) });
  await proof.locator("summary").click();
  await expect(proof.locator("blockquote")).toHaveText(S2);
  await expect(proof).toContainText("characters 44–153");
  expect(await view.locator("img, script, iframe").count()).toBe(0);
  expect(await view.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(requests.every((u) => u.startsWith("file:"))).toBe(true);
  await view.screenshot({ path: `${EVIDENCE}/screenshots/${tag}-G3-offline-html.png`, fullPage: true });
  await offline.close();

  const envelope = JSON.parse(json.body);
  expect(envelope.status_at_export).toBe("acknowledged_by_user");
  await nav(page, "الدرس");
  await page.getByTestId("import-input").setInputFiles(jsonPath);
  await page.getByRole("button", { name: REPLACE }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expectStatus(page, "draft");
  await expect(page.getByRole("status")).toContainText("local_review");
  const after = await stored(page);
  expect(after.review).toBeNull();
  expect(after.draft).toEqual(envelope.draft);
});
