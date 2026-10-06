import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../../docs/review/G4-B-P1/screenshots");
mkdirSync(SHOTS, { recursive: true });

type Json = Record<string, any>;

const shot = (page: Page, project: string, name: string) =>
  page.screenshot({ path: `${SHOTS}/${project}-P1-${name}.png`, fullPage: true });
const mainNav = (page: Page) => page.getByRole("navigation", { name: "التنقل الرئيسي" });
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const RAW_PUA = /[-]/;

async function api(page: Page, path: string): Promise<Json> {
  const res = await page.request.get(path);
  expect(res.ok(), `${path} → ${res.status()}`).toBe(true);
  return res.json();
}

const FATWA_ID = "binbaz-p1mock";
const FATWA = {
  id: FATWA_ID,
  title: "سؤال تجريبي عن الحواشي والرموز",
  question: [[{ kind: "text", text: "ما المقصود بهذه المسألة؟" }, { kind: "noteref", text: "[1]", note: "1" }]],
  answer: [
    [
      { kind: "text", text: "قال الله : كلام، وسبّح الرب  وحده" },
      { kind: "noteref", text: "[2]", note: "2" },
    ],
    [
      { kind: "text", text: "عن جابر  عن النبي ﷺ، وجمع الصحابة  وأرضاهم" },
      { kind: "strong", text: " ورمز آخر  هنا" },
      { kind: "noteref", text: "[1]", note: "1" },
    ],
  ],
  notes: [
    { id: "1", runs: [{ kind: "text", text: "الحاشية الأولى عن جابر  <b>نص</b>" }] },
    { id: "2", runs: [{ kind: "text", text: "الحاشية الثانية" }] },
  ],
  topic: "belief",
  source_categories: [],
  source: {
    publisher: "binbaz.org.sa",
    publisher_name: "binbaz.org.sa",
    url: "https://binbaz.org.sa/fatwas/1996",
    retrieved_at: "2026-10-06T00:00:00+00:00",
  },
  schema: "balligh.library.fatwa/2",
};

const HADITH_ID = "hadeethenc-p1mock";
const HADITH = {
  id: HADITH_ID,
  title: "حديث تجريبي",
  text: "نص الحديث التجريبي",
  attribution: "متفق عليه",
  reference: null,
  grade: "صحيح",
  grading_authority: null,
  narrator: null,
  explanation: "الشرح المنشور التجريبي",
  hints: [],
  topic: "belief",
  source_categories: [],
  source: { publisher: "HadeethEnc.com", url: "https://hadeethenc.com/ar/browse/hadith/1", retrieved_at: "2026-10-06T00:00:00+00:00" },
  dorar: null,
  schema: "balligh.library.hadith/2",
  words_meanings: [
    { word: "الكلمة الأولى", meaning: "معناها الأول" },
    { word: "الكلمة الثانية", meaning: "معناها الثاني" },
  ],
};
const HADITH_TR: Record<string, Json> = {
  en: {
    title: "Test hadith",
    text: "The test hadith in English",
    attribution: "Agreed upon",
    grade: "Authentic",
    explanation: "Published explanation in English",
    hints: [],
    source_url: "https://hadeethenc.com/en/browse/hadith/1",
    arabic_match: "exact",
    words_meanings: null,
  },
  fr: {
    title: "Hadith de test",
    text: "Le hadith de test en français",
    attribution: "Rapporté par les deux",
    grade: "Authentique",
    explanation: "Explication publiée",
    hints: [],
    source_url: "https://hadeethenc.com/fr/browse/hadith/1",
    arabic_match: "not_provided",
    words_meanings: [{ word: "mot", meaning: "sens du mot" }],
    words_meanings_language: "fr",
  },
};

async function mockFatwa(page: Page) {
  await page.route(
    (u) => u.pathname === `/api/library/fatwas/${FATWA_ID}`,
    (route) => {
      const locale = new URL(route.request().url()).searchParams.get("locale") ?? "ar";
      return route.fulfill({
        json: {
          record: FATWA,
          locale,
          translation_status: locale === "ar" ? "original" : "unavailable",
          translation: null,
          dir: locale === "ar" || locale === "ur" ? "rtl" : "ltr",
          available_locales: ["ar"],
        },
      });
    },
  );
}

async function mockHadith(page: Page) {
  await page.route(
    (u) => u.pathname === `/api/library/hadith/${HADITH_ID}`,
    (route) => {
      const locale = new URL(route.request().url()).searchParams.get("locale") ?? "ar";
      const tr = HADITH_TR[locale] ?? null;
      return route.fulfill({
        json: {
          record: HADITH,
          locale,
          translation_status: locale === "ar" ? "original" : tr ? "available" : "unavailable",
          translation: tr,
          available_locales: ["ar", "en", "fr"],
        },
      });
    },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
});

test("the test-data banner stays with the lesson and never covers library pages; lesson state is unchanged", async ({
  page,
}, info) => {
  const mobile = info.project.name.startsWith("mobile");
  await page.goto("/");
  await page.getByRole("button", { name: "جرّب درسًا" }).click();
  await expect(page).toHaveURL(/\/preview$/);
  await mainNav(page).getByRole("link", { name: "المراجعة", exact: true }).click();
  if (mobile) await page.getByRole("tab", { name: "الإقرار" }).click();
  const panel = page.getByTestId("ack-panel");
  await panel.getByLabel("اسمك أو وسمك").fill("G4-A-P1 banner tester");
  await panel.getByLabel("قارنت هذه النسخة بالمصدر").check();
  await panel.getByRole("button", { name: "أقرّ هذه النسخة" }).click();
  await expect.poll(() => page.getByTestId("review-status").first().getAttribute("data-status")).toBe("acknowledged_by_user");
  await expect(page.getByTestId("testdata-banner")).toBeVisible();
  await mainNav(page).getByRole("link", { name: "الدرس", exact: true }).click();
  await page.getByTestId("mark-read").click();
  await page.waitForTimeout(400);
  const progressText = await page.getByTestId("progress-count").innerText();
  await expect(page.getByTestId("testdata-banner")).toBeVisible();
  await expect(page.getByTestId("testdata-banner")).toContainText("بيانات اختبارية");
  const snapshot = () =>
    page.evaluate(() =>
      Object.fromEntries(
        Object.keys(localStorage)
          .filter((k) => k.startsWith("balligh.") && k !== "balligh.reading.v1")
          .sort()
          .map((k) => [k, localStorage.getItem(k)]),
      ),
    );
  const before = await snapshot();
  expect(before["balligh.workspace.v1"]).toBeTruthy();
  expect(before["balligh.progress.v1"]).toBeTruthy();
  await shot(page, info.project.name, "banner-lesson");

  await mainNav(page).getByRole("link", { name: "المكتبة", exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("المكتبة");
  await expect(page.getByTestId("testdata-banner")).toHaveCount(0);
  await expect(page.getByText("بيانات اختبارية")).toHaveCount(0);
  await shot(page, info.project.name, "banner-library-home");
  await page.getByTestId("collection-quran").click();
  await expect(page).toHaveURL(/\/library\/quran$/);
  await expect(page.getByTestId("surah-link").first()).toBeVisible();
  await expect(page.getByTestId("testdata-banner")).toHaveCount(0);
  await page.getByTestId("back-link").click();
  await page.getByTestId("collection-questions").click();
  await expect(page).toHaveURL(/\/library\/questions$/);
  await expect(page.getByTestId("item-link").first()).toBeVisible();
  await expect(page.getByTestId("testdata-banner")).toHaveCount(0);
  await page.getByTestId("item-link").first().click();
  await expect(page.getByTestId("item-title")).toBeVisible();
  await expect(page.getByTestId("testdata-banner")).toHaveCount(0);
  await expect(page.getByTestId("credit")).toBeVisible();
  await expect(page.getByTestId("status-note")).toBeVisible();
  await mainNav(page).getByRole("link", { name: "المكتبة", exact: true }).click();
  await page.getByTestId("collection-hadith").click();
  await expect(page).toHaveURL(/\/library\/hadith$/);
  await expect(page.getByTestId("item-link").first()).toBeVisible();
  await expect(page.getByTestId("testdata-banner")).toHaveCount(0);
  await shot(page, info.project.name, "banner-library-hadith");
  expect(await snapshot()).toEqual(before);

  await page.goto("/preview");
  await expect(page).toHaveURL(/\/preview$/);
  await expect(page.getByTestId("lesson")).toBeVisible();
  await expect(page.getByTestId("testdata-banner")).toBeVisible();
  await expect(page.getByTestId("progress-count")).toHaveText(progressText);
  await expect(page.getByTestId("review-status").first()).toHaveAttribute("data-status", "acknowledged_by_user");
  await mainNav(page).getByRole("link", { name: "المراجعة", exact: true }).click();
  await expect(page.getByTestId("testdata-banner")).toBeVisible();
  expect(await snapshot()).toEqual(before);
});

test("fatwa notes: each reference links to its numbered note and the note links back to its first reference", async ({
  page,
}, info) => {
  await mockFatwa(page);
  await page.goto(`/library/questions/${FATWA_ID}`);
  await expect(page.getByTestId("item-title")).toHaveText(FATWA.title);
  const refs = page.getByTestId("noteref");
  await expect(refs).toHaveText(["[1]", "[2]", "[1]"]);
  await expect(refs.nth(0)).toHaveAttribute("href", `#note-${FATWA_ID}-1`);
  await expect(refs.nth(1)).toHaveAttribute("href", `#note-${FATWA_ID}-2`);
  await expect(refs.nth(2)).toHaveAttribute("href", `#note-${FATWA_ID}-1`);
  await expect(refs.nth(0)).toHaveAttribute("id", `noteref-${FATWA_ID}-1`);
  await expect(refs.nth(1)).toHaveAttribute("id", `noteref-${FATWA_ID}-2`);
  await expect(refs.nth(2)).not.toHaveAttribute("id", /.+/);

  const notes = page.getByTestId("fatwa-notes");
  await expect(notes.getByRole("heading")).toHaveText("الحواشي");
  await expect(notes.getByTestId("note")).toHaveCount(2);
  await expect(notes.getByTestId("note-number")).toHaveText(["[1]", "[2]"]);
  await expect(notes.getByTestId("note").nth(0)).toHaveAttribute("id", `note-${FATWA_ID}-1`);
  await expect(notes.getByTestId("note").nth(1)).toHaveAttribute("id", `note-${FATWA_ID}-2`);
  const list = notes.getByTestId("note-list");
  expect(await list.evaluate((el) => el.closest("[dir]")?.getAttribute("dir"))).toBe("rtl");
  expect(await list.evaluate((el) => el.closest("[lang]")?.getAttribute("lang"))).toBe("ar");
  await expect(notes.getByTestId("note").nth(0)).toContainText("<b>نص</b>");
  await expect(notes.locator("b, script")).toHaveCount(0);
  const answerBox = await page.getByTestId("fatwa-answer").boundingBox();
  const notesBox = await notes.boundingBox();
  expect(notesBox!.y).toBeGreaterThan(answerBox!.y);

  await refs.nth(0).click();
  await expect(page).toHaveURL(new RegExp(`#note-${FATWA_ID}-1$`));
  await expect(page.locator(`#note-${FATWA_ID}-1`)).toBeInViewport();
  await shot(page, info.project.name, "notes-target");
  await page.locator(`#note-${FATWA_ID}-1`).getByTestId("note-back").click();
  await expect(page).toHaveURL(new RegExp(`#noteref-${FATWA_ID}-1$`));
  await expect(page.locator(`#noteref-${FATWA_ID}-1`)).toBeInViewport();
  await refs.nth(1).click();
  await expect(page).toHaveURL(new RegExp(`#note-${FATWA_ID}-2$`));
  await expect(page.locator(`#note-${FATWA_ID}-2`)).toBeInViewport();
  await page.locator(`#note-${FATWA_ID}-2`).getByTestId("note-back").click();
  await expect(page).toHaveURL(new RegExp(`#noteref-${FATWA_ID}-2$`));
  await expect(page.locator(`#noteref-${FATWA_ID}-2`)).toBeInViewport();
  await expect(page.getByTestId("fatwa-reader")).toHaveAttribute("data-id", FATWA_ID);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, info.project.name, "notes");

  const real = await api(page, "/api/library/fatwas?page=1&page_size=1");
  const rec = (await api(page, `/api/library/fatwas/${encodeURIComponent(real.items[0].id)}?locale=ar`)).record;
  await page.goto(`/library/questions/${encodeURIComponent(rec.id)}`);
  await expect(page.getByTestId("item-title")).toHaveText(rec.title);
  await expect(page.getByTestId("fatwa-answer").locator("p")).toHaveCount(rec.answer.length);
  if (!rec.notes?.length) await expect(page.getByTestId("fatwa-notes")).toHaveCount(0);
});

test("hadith word meanings are an attributed Arabic block, never the selected-language translation", async ({
  page,
}, info) => {
  await mockHadith(page);
  await page.goto(`/library/hadith/${HADITH_ID}?lang=en`);
  const words = page.getByTestId("hadith-words");
  await expect(words.getByRole("heading")).toHaveText("معاني الكلمات (موسوعة الأحاديث النبوية)");
  await expect(words).toContainText("وليس ترجمة");
  const wl = page.getByTestId("hadith-words-list");
  await expect(wl).toHaveAttribute("lang", "ar");
  await expect(wl).toHaveAttribute("dir", "rtl");
  await expect(wl.getByTestId("word-meaning")).toHaveCount(2);
  await expect(wl).toContainText("الكلمة الأولى");
  await expect(wl).toContainText("معناها الثاني");
  const translation = page.getByTestId("hadith-translation");
  await expect(translation).toHaveAttribute("lang", "en");
  await expect(translation).not.toContainText("الكلمة الأولى");
  await expect(translation.getByTestId("hadith-words-list")).toHaveCount(0);
  await expect(page.getByTestId("hadith-words-localized")).toHaveCount(0);
  await expect(page.getByText("الترجمة مرتبطة بهذا النص العربي نفسه")).toBeHidden();
  await page.getByTestId("tech-details").locator("summary").click();
  await expect(page.getByTestId("tech-details")).toContainText("مطابقة النص العربي");
  await expect(page.getByTestId("tech-details")).toContainText("الترجمة مرتبطة بهذا النص العربي نفسه");
  await shot(page, info.project.name, "hadith-words");

  await page.getByTestId("reading-language").selectOption("fr");
  await expect(page.getByTestId("hadith-translation")).toHaveAttribute("lang", "fr");
  const local = page.getByTestId("hadith-words-localized");
  await expect(local.getByRole("heading")).toContainText("Français");
  await expect(local.getByTestId("hadith-words-localized-list")).toHaveAttribute("lang", "fr");
  await expect(local.getByTestId("hadith-words-localized-list")).toHaveAttribute("dir", "ltr");
  await expect(local).toContainText("sens du mot");
  await expect(page.getByTestId("hadith-words-list")).toHaveAttribute("lang", "ar");
  await page.getByTestId("tech-details").locator("summary").click();
  await expect(page.getByTestId("tech-details")).toContainText("لم يتضمن رد الناشر النص العربي للمقارنة");

  await page.locator("header select").selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByTestId("hadith-words").getByRole("heading")).toHaveText("Word meanings (HadeethEnc, Arabic)");
  await expect(page.getByTestId("hadith-words-list")).toHaveAttribute("dir", "rtl");
  await page.locator("header select").selectOption("ar");
});

test("Quran credits: the publisher's own statement for the selected edition, and QuranEnc as a separate electronic provider", async ({
  page,
}, info) => {
  const quran = await api(page, "/api/library/quran");
  const zh = (quran.editions as Json[]).find((e) => e.locale === "zh-Hans")!;
  const id = (quran.editions as Json[]).find((e) => e.locale === "id")!;
  expect(zh.description).toContain("Translated by Muhammad Makeen");
  expect(zh.description).toContain("Reviewed by Muhammad Sulaiman");
  expect(id.description).toContain("Indonesian Ministry of Religious Affairs");
  expect(id.description).toContain("Rowwad");
  const first = (quran.surahs as Json[])[0].number;

  await page.goto(`/library/quran/${first}?lang=zh-Hans`);
  await expect(page.getByTestId("ayah").first()).toBeVisible();
  await expect(page.getByTestId("edition-line")).toContainText(zh.title);
  await expect(page.getByTestId("edition-line")).toContainText(String(zh.version));
  await expect(page.getByTestId("edition-description-text")).toHaveText(zh.description);
  await expect(page.getByTestId("edition-description-text")).toHaveAttribute("lang", "en");
  const provider = page.getByTestId("edition-provider");
  await expect(provider).toContainText("المزوّد الإلكتروني:");
  await expect(provider.getByRole("link", { name: "QuranEnc.com" })).toHaveAttribute("href", zh.browse_url);
  await expect(page.getByTestId("edition-description")).not.toContainText("QuranEnc");
  const tafsir = page.getByTestId("tafsir-credit");
  if ((quran.tafsir as Json[]).length > 0) {
    await expect(page.getByTestId("tafsir-publisher")).toContainText("مجمع الملك فهد لطباعة المصحف الشريف");
    await expect(tafsir).toContainText("الإصدار");
    await expect(page.getByTestId("tafsir-provider").getByRole("link", { name: "QuranEnc.com" })).toBeVisible();
    await expect(tafsir).not.toContainText("حكوم");
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, info.project.name, "quran-credits-zh");

  await page.getByTestId("reading-language").selectOption("id");
  await expect(page.getByTestId("surah-body")).toHaveAttribute("data-locale", "id");
  await expect(page.getByTestId("edition-description-text")).toHaveText(id.description);
  await expect(page.getByTestId("edition-description-text")).toContainText("Ministry of Religious Affairs");
  await expect(page.getByTestId("edition-description-text")).toContainText("Developed under the supervision of Rowwad");
  await expect(page.getByTestId("edition-provider").getByRole("link", { name: "QuranEnc.com" })).toHaveAttribute(
    "href",
    id.browse_url,
  );
  await shot(page, info.project.name, "quran-credits-id");

  await page.locator("header select").selectOption("en");
  await expect(page.getByTestId("edition-provider")).toContainText("Electronic provider:");
  if ((quran.tafsir as Json[]).length > 0) {
    await expect(page.getByTestId("tafsir-publisher")).toContainText("Original publisher: King Fahd Quran Printing Complex");
    await expect(page.getByTestId("tafsir-provider")).toContainText("Delivered through");
    await expect(page.getByTestId("tafsir-credit")).not.toContainText(/government/i);
  }
  await page.locator("header select").selectOption("ar");

  await page.goto("/library/quran?lang=zh-Hans");
  await expect(page.getByTestId("quran-edition-credits")).toContainText(zh.description);
  await expect(page.getByTestId("quran-edition-credits").getByTestId("edition-provider")).toContainText("QuranEnc.com");
});

test("Ibn Baz honorific glyphs render as readable Arabic text, unknown glyphs keep the labelled marker", async ({
  page,
}, info) => {
  await mockFatwa(page);
  await page.goto(`/library/questions/${FATWA_ID}`);
  await expect(page.getByTestId("item-title")).toHaveText(FATWA.title);
  const expected: Record<string, string> = {
    F049: "سبحانه وتعالى",
    F055: "عز وجل",
    F074: "رضي الله عنه",
    F079: "رضي الله عنهم",
  };
  const answer = page.getByTestId("fatwa-answer");
  for (const [code, text] of Object.entries(expected)) {
    const el = answer.locator(`[data-testid=honorific-text][data-glyph="${code}"]`);
    await expect(el).toHaveCount(1);
    await expect(el).toHaveText(text);
    await expect(el).toHaveAttribute("lang", "ar");
    await expect(el).toHaveAttribute("dir", "rtl");
    await expect(el).toHaveAttribute("title", "رمز تعظيم من خط موقع المصدر معروض هنا نصًّا مقروءًا، والنص المحفوظ لم يتغير");
  }
  await expect(page.getByTestId("fatwa-notes").locator('[data-glyph="F074"]')).toHaveText("رضي الله عنه");
  const shown = squash(await answer.innerText());
  expect(shown).toContain("قال الله عز وجل: كلام، وسبّح الرب سبحانه وتعالى وحده");
  expect(shown).toContain("عن جابر رضي الله عنه عن النبي ﷺ، وجمع الصحابة رضي الله عنهم وأرضاهم");
  const marker = page.getByTestId("honorific-marker");
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute("data-glyph", "F0AA");
  await expect(marker).toHaveAttribute("role", "img");
  await expect(marker).toHaveAttribute("aria-label", "رمز تعظيم يظهر بخط خاص في موقع المصدر");
  expect(shown).toContain("ورمز آخر");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  expect(await page.getByTestId("fatwa-reader").innerText()).not.toMatch(RAW_PUA);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, info.project.name, "honorifics-ar");

  await page.locator("header select").selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByTestId("item-original")).toHaveAttribute("dir", "rtl");
  const f049 = answer.locator('[data-testid=honorific-text][data-glyph="F049"]');
  await expect(f049).toHaveText("سبحانه وتعالى");
  await expect(f049).toHaveAttribute("dir", "rtl");
  await expect(f049).toHaveAttribute("title", "The publisher's honorific symbol, shown here as readable text; the stored text is unchanged");
  await expect(page.getByTestId("honorific-marker")).toHaveAttribute(
    "aria-label",
    "Honorific symbol shown in the publisher's own font — see the original page",
  );
  await expect(page.getByTestId("fatwa-notes").getByRole("heading")).toHaveText("Notes");
  expect(await page.getByTestId("fatwa-reader").innerText()).not.toMatch(RAW_PUA);
  await shot(page, info.project.name, "honorifics-en");
  await page.locator("header select").selectOption("ar");

  const real = await page.request.get("/api/library/fatwas/binbaz-1996?locale=ar");
  if (real.ok()) {
    const rec = (await real.json()).record;
    await page.goto("/library/questions/binbaz-1996");
    await expect(page.getByTestId("item-title")).toHaveText(rec.title);
    await expect(page.locator('[data-testid=honorific-text][data-glyph="F079"]').first()).toHaveText("رضي الله عنهم");
    expect(await page.getByTestId("fatwa-reader").innerText()).not.toMatch(RAW_PUA);
  }
});
