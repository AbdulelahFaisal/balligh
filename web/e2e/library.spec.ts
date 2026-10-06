import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../../docs/review/G4-B-P1/screenshots");
mkdirSync(SHOTS, { recursive: true });
const WS = "balligh.workspace.v1";
const PROGRESS = "balligh.progress.v1";
const TOPIC_AR: Record<string, string> = {
  understanding_islam: "التعريف بالإسلام",
  belief: "العقيدة",
  worship: "العبادات",
  conduct: "الأخلاق والآداب",
};

type Json = Record<string, any>;

const shot = (page: Page, project: string, name: string) =>
  page.screenshot({ path: `${SHOTS}/${project}-A-${name}.png`, fullPage: true });
const mainNav = (page: Page) => page.getByRole("navigation", { name: "التنقل الرئيسي" });
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const runsText = (paras: Json[][]) => paras.map((p) => p.map((r) => r.text).join("")).join("\n");

async function api(page: Page, path: string): Promise<Json> {
  const res = await page.request.get(path);
  expect(res.ok(), `${path} → ${res.status()}`).toBe(true);
  return res.json();
}

function hold(page: Page, match: (u: URL) => boolean) {
  const held: Route[] = [];
  const box = { seen: 0 };
  const ready = page.route(match, (route) => {
    box.seen += 1;
    held.push(route);
  });
  return {
    ready,
    box,
    release: async () => {
      for (const r of held.splice(0)) await r.continue().catch(() => undefined);
    },
    fail: async () => {
      for (const r of held.splice(0))
        await r
          .fulfill({ status: 500, json: { detail: { code: "held", message: "held failure" } } })
          .catch(() => undefined);
    },
  };
}

async function footnoteSurah(page: Page) {
  const quran = await api(page, "/api/library/quran");
  const edition = (quran.editions as Json[]).find((e) => (e.footnote_ayahs ?? 0) > 0) ?? quran.editions[0];
  const locale: string = edition.locale;
  const bySize = [...(quran.surahs as Json[])].sort((a, b) => a.ayah_count - b.ayah_count);
  for (const s of bySize.slice(0, 40)) {
    const surah = await api(page, `/api/library/quran/${s.number}?locale=${locale}`);
    const aya = (surah.ayahs as Json[]).find((a) => typeof a.footnotes === "string" && a.footnotes.trim());
    if (aya) return { quran, locale, surah, aya };
  }
  throw new Error("no delivered surah has a footnote in the first 40 short surahs");
}

async function hadithWith(page: Page, locales: string[]) {
  const list = await api(page, "/api/library/hadith?page=1&page_size=50");
  for (const item of list.items as Json[]) {
    const d = await api(page, `/api/library/hadith/${encodeURIComponent(item.id)}?locale=ar`);
    if (locales.every((l) => (d.available_locales as string[]).includes(l))) return d.record as Json;
  }
  throw new Error(`no hadith on page 1 has ${locales.join(", ")}`);
}

async function longestFatwa(page: Page) {
  const list = await api(page, "/api/library/fatwas?page=1&page_size=50");
  let best: Json | null = null;
  for (const item of list.items as Json[]) {
    const d = await api(page, `/api/library/fatwas/${encodeURIComponent(item.id)}?locale=ar`);
    if (!best || runsText(d.record.answer).length > runsText(best.answer).length) best = d.record;
  }
  return best!;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
});

test("library home leads to each of the three collections and back", async ({ page }, info) => {
  const quran = await api(page, "/api/library/quran");
  await page.goto("/");
  await mainNav(page).getByRole("link", { name: "المكتبة", exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("المكتبة");
  await expect(page.getByTestId("collection-quran")).toContainText("القرآن الكريم");
  await expect(page.getByTestId("collection-questions")).toContainText("فتاوى");
  await expect(page.getByTestId("collection-hadith")).toContainText("أحاديث صحيحة");
  await expect(page.getByTestId("collection-quran")).toContainText(
    quran.range.kind === "full" ? "القرآن الكريم كاملًا" : "جزء عمّ فقط",
  );
  await shot(page, info.project.name, "home");

  await page.getByTestId("collection-quran").click();
  await expect(page).toHaveURL(/\/library\/quran$/);
  await expect(page.getByTestId("quran-range")).toContainText(String(quran.range.ayah_count));
  await expect(page.getByTestId("surah-link")).toHaveCount(quran.surahs.length);
  await expect(page.locator("video")).toHaveCount(0);
  for (const media of await page.locator("audio").all()) {
    expect(await media.getAttribute("src")).toBeNull();
    await expect(media).toHaveAttribute("preload", "none");
  }
  await shot(page, info.project.name, "quran-list");
  await page.getByTestId("back-link").click();
  await expect(page).toHaveURL(/\/library$/);

  await page.getByTestId("collection-questions").click();
  await expect(page).toHaveURL(/\/library\/questions$/);
  await expect(page.getByTestId("item-link").first()).toBeVisible();
  await page.getByTestId("back-link").click();
  await page.getByTestId("collection-hadith").click();
  await expect(page).toHaveURL(/\/library\/hadith$/);
  await expect(page.getByTestId("item-link").first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("topic filter, title search, empty search, Back and the back link keep the filters, keyboard opens an item", async ({
  page,
}, info) => {
  const all = await api(page, "/api/library/fatwas?page=1&page_size=1");
  const topic: string = all.topics[0];
  const inTopic = await api(page, `/api/library/fatwas?topic=${topic}&page=1&page_size=50`);
  await page.goto("/library/questions");
  await expect(page.getByTestId("result-count")).toContainText(String(all.total));
  await page.getByRole("button", { name: TOPIC_AR[topic], exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`topic=${topic}`));
  await expect(page.getByRole("button", { name: TOPIC_AR[topic], exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("result-count")).toContainText(String(inTopic.total));

  const first = inTopic.items[0] as Json;
  const word = (first.title as string).split(/\s+/).filter((w) => w.length >= 3).sort((a, b) => b.length - a.length)[0];
  const matching = await api(page, `/api/library/fatwas?topic=${topic}&q=${encodeURIComponent(word)}&page=1&page_size=50`);
  expect(matching.total).toBeGreaterThan(0);
  await page.getByTestId("library-search").fill(word);
  await page.getByTestId("library-search").press("Enter");
  await expect(page).toHaveURL(/q=/);
  await expect(page.getByTestId("result-count")).toContainText(String(matching.total));
  await expect(page.getByTestId("item-link").first()).toContainText(matching.items[0].title);

  await page.getByTestId("item-link").first().click();
  await expect(page).toHaveURL(new RegExp(`/library/questions/${matching.items[0].id}\\?.*topic=${topic}`));
  await expect(page.getByTestId("item-title")).toHaveText(matching.items[0].title);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/library/questions\\?.*topic=${topic}.*q=`));
  await expect(page.getByTestId("library-search")).toHaveValue(word);
  await expect(page.getByRole("button", { name: TOPIC_AR[topic], exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("result-count")).toContainText(String(matching.total));

  await page.getByTestId("item-link").first().click();
  await expect(page.getByTestId("item-title")).toHaveText(matching.items[0].title);
  await page.getByTestId("back-link").click();
  await expect(page).toHaveURL(new RegExp(`/library/questions\\?.*topic=${topic}.*q=`));
  await expect(page.getByTestId("library-search")).toHaveValue(word);

  await page.getByTestId("library-search").fill("كلمةلاتوجدفيأيعنوانxyz");
  await page.getByTestId("library-search").press("Enter");
  await expect(page.getByTestId("library-empty")).toContainText("لا توجد نتائج تطابق");
  await expect(page.getByTestId("result-count")).toContainText("0");
  await expect(page.getByText("يطابق الكلمات التي تكتبها في العناوين والموضوعات والمراجع")).toBeVisible();
  await shot(page, info.project.name, "empty-search");
  await page.getByRole("button", { name: "امسح البحث" }).click();
  await expect(page.getByTestId("item-link").first()).toBeVisible();

  await page.getByTestId("library-search").focus();
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "item-link");
  }
  expect(reached).toBe(true);
  const focused = page.locator("[data-testid=item-link]:focus");
  await expect(focused).toHaveCount(1);
  const outline = await focused.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");
  const id = await focused.getAttribute("data-id");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/library/questions/${id}`));
  await expect(page.getByTestId("fatwa-reader")).toHaveAttribute("data-id", id!);
});

test("a long fatwa renders completely in Arabic; a language with no stored translation shows the honest unavailable message and the source link", async ({
  page,
}, info) => {
  const rec = await longestFatwa(page);
  // A stored AI-assisted English translation replaces the unavailable message; the Arabic check then runs in Arabic.
  const translated = Boolean((await api(page, `/api/library/fatwas/${encodeURIComponent(rec.id)}?locale=en`)).machine_translation);
  await page.goto(`/library/questions/${encodeURIComponent(rec.id)}?lang=${translated ? "ar" : "en"}`);
  await expect(page.getByTestId("item-title")).toHaveText(rec.title);
  await expect(page.getByTestId("item-title")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("item-title")).toHaveAttribute("lang", "ar");
  if (!translated) await expect(page.getByTestId("translation-unavailable")).toContainText("English");
  await expect(page.getByTestId("item-original")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("item-original")).toHaveAttribute("lang", "ar");
  await expect(page.getByTestId("fatwa-answer").locator("p")).toHaveCount(rec.answer.length);
  const shown = squash(await page.getByTestId("fatwa-answer").innerText());
  for (const para of rec.answer as Json[][]) {
    const text = squash(para.map((r) => r.text).join(""));
    expect(shown).toContain(text.slice(-40));
  }
  const link = page.getByTestId("source-link").first();
  await expect(link).toHaveAttribute("href", /^https:\/\/(www\.)?binbaz\.org\.sa\//);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.getByTestId("status-note")).toContainText("النص كما نشره المصدر"); // G5-D: the blanket not-reviewed notice was removed at the user's request
  await expect(page.getByTestId("credit")).toContainText("binbaz.org.sa — الموقع الرسمي لسماحة الشيخ عبد العزيز بن باز");
  await expect(page.getByTestId("credit")).toContainText("تاريخ الجلب");
  const tech = page.getByTestId("tech-details");
  await expect(tech).not.toHaveAttribute("open", "");
  await expect(page.getByText(rec.content_sha256)).toBeHidden();
  await shot(page, info.project.name, "missing-translation");

  await page.getByTestId("reading-language").selectOption("ar");
  await expect(page).toHaveURL(/lang=ar/);
  await expect(page.getByTestId("translation-unavailable")).toHaveCount(0);
  await expect(page.getByTestId("item-title")).toHaveText(rec.title);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, info.project.name, "fatwa-reader");
});

test("publisher-font honorific symbols in a fatwa show as readable text or a labelled marker, never a raw private-use character", async ({
  page,
}) => {
  const label = "رمز تعظيم يظهر بخط خاص في موقع المصدر";
  const known: Record<string, string> = { F049: "سبحانه وتعالى", F055: "عز وجل", F074: "رضي الله عنه", F079: "رضي الله عنهم" };
  let id = "";
  for (const candidate of ["binbaz-1996", "binbaz-2354"]) {
    if ((await page.request.get(`/api/library/fatwas/${candidate}?locale=ar`)).ok()) {
      id = candidate;
      break;
    }
  }
  expect(id).not.toBe("");
  const rec = (await api(page, `/api/library/fatwas/${id}?locale=ar`)).record;
  expect(runsText([...rec.question, ...rec.answer])).toMatch(/[\uE000-\uF8FF]/);
  await page.goto(`/library/questions/${id}`);
  await expect(page.getByTestId("item-title")).toHaveText(rec.title);
  const codes = [...runsText([...rec.question, ...rec.answer]).matchAll(/[\uE000-\uF8FF]/g)].map((m) =>
    m[0].codePointAt(0)!.toString(16).toUpperCase(),
  );
  const mapped = codes.filter((c) => c in known);
  await expect(page.getByTestId("honorific-text")).toHaveCount(mapped.length);
  for (const c of new Set(mapped)) await expect(page.locator(`[data-glyph="${c}"]`).first()).toHaveText(known[c]);
  await expect(page.getByTestId("honorific-marker")).toHaveCount(codes.length - mapped.length);
  if (codes.length > mapped.length) {
    const marker = page.getByTestId("honorific-marker").first();
    await expect(marker).toBeVisible();
    await expect(marker).toHaveAttribute("role", "img");
    await expect(marker).toHaveAttribute("aria-label", label);
    await expect(marker).toHaveAttribute("title", label);
  }
  expect(await page.getByTestId("fatwa-reader").innerText()).not.toMatch(/[\uE000-\uF8FF]/);
});

test("an Arabic-only hadith says the chosen language is unavailable and shows the Arabic original", async ({ page }) => {
  let rec: Json | null = null;
  for (const id of ["hadeethenc-65355", "hadeethenc-66212", "hadeethenc-66239", "hadeethenc-66397"]) {
    const res = await page.request.get(`/api/library/hadith/${id}?locale=en`);
    if (!res.ok()) continue;
    const d = await res.json();
    if (d.translation_status === "unavailable") {
      rec = d.record;
      break;
    }
  }
  expect(rec).not.toBeNull();
  await page.goto(`/library/hadith/${rec!.id}?lang=en`);
  await expect(page.getByTestId("translation-unavailable")).toContainText("English");
  await expect(page.getByTestId("item-title")).toHaveAttribute("lang", "ar");
  await expect(page.getByTestId("hadith-translation")).toHaveCount(0);
  expect(squash(await page.getByTestId("hadith-text").innerText())).toBe(squash(rec!.text));
  await expect(page.getByTestId("available-locales")).toContainText("العربية");
});

test("hadith reader: Arabic and translation directions, grade as published, Dorar not checked, explanation kept apart", async ({
  page,
}, info) => {
  const rec = await hadithWith(page, ["en", "ur"]);
  await page.goto(`/library/hadith/${encodeURIComponent(rec.id)}?lang=en`);
  const translation = page.getByTestId("hadith-translation");
  await expect(translation).toHaveAttribute("lang", "en");
  await expect(translation).toHaveAttribute("dir", "ltr");
  await expect(page.getByTestId("item-original")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("hadith-text")).toBeVisible();
  expect(squash(await page.getByTestId("hadith-text").innerText())).toBe(squash(rec.text));
  if (rec.grade) await expect(page.getByTestId("hadith-grade")).toHaveText(rec.grade);
  await expect(page.getByTestId("hadith-dorar")).toContainText("لم تُقارَن");
  await expect(page.getByTestId("hadith-dorar")).toContainText("dorar.net");
  if (rec.reference) {
    await page.getByTestId("hadith-reference-details").locator("summary").click();
    expect(squash(await page.getByTestId("hadith-reference").innerText())).toBe(squash(rec.reference));
  }
  await expect(page.getByTestId("credit").first()).toContainText("HadeethEnc.com");
  await expect(page.getByTestId("credit").first()).toContainText("تاريخ الجلب");
  await expect(page.getByTestId("credit").first().getByRole("link")).toHaveAttribute("href", /^https:\/\/(www\.)?hadeethenc\.com\//);
  await expect(page.getByTestId("hadith-explanation")).toContainText("الشرح المنشور");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await shot(page, info.project.name, "hadith-reader");

  await page.getByTestId("reading-language").selectOption("ur");
  await expect(page.getByTestId("hadith-translation")).toHaveAttribute("lang", "ur");
  await expect(page.getByTestId("hadith-translation")).toHaveAttribute("dir", "rtl");

  await page.locator("header select").selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByTestId("item-original")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("item-original")).toHaveAttribute("lang", "ar");
  await page.locator("header select").selectOption("ar");
});

test("surah reader: every ayah with its translation of the meanings and footnotes; the longest surah renders fully", async ({
  page,
}, info) => {
  const { quran, locale, surah, aya } = await footnoteSurah(page);
  await page.goto(`/library/quran/${surah.number}?lang=${locale}`);
  await expect(page.getByTestId("surah-reader")).toHaveAttribute("data-number", String(surah.number));
  await expect(page.getByTestId("ayah")).toHaveCount(surah.ayah_count);
  await expect(page.getByTestId("edition-line")).toContainText("ترجمة معاني القرآن الكريم");
  await expect(page.getByTestId("edition-line")).toContainText(String(surah.edition.version));
  await expect(page.getByTestId("edition-provider").getByRole("link", { name: "QuranEnc.com" })).toHaveAttribute("href", surah.edition.browse_url);
  const first = page.getByTestId("ayah").first();
  await expect(first.getByTestId("ayah-arabic")).toHaveAttribute("dir", "rtl");
  await expect(first.getByTestId("ayah-arabic")).toHaveAttribute("lang", "ar");
  await expect(first.getByTestId("ayah-translation")).toHaveAttribute("lang", locale);
  await expect(first.getByTestId("ayah-translation")).toHaveAttribute("dir", locale === "ur" ? "rtl" : "ltr");
  const noted = page.locator(`[data-testid=ayah][data-aya="${aya.aya}"]`);
  await noted.scrollIntoViewIfNeeded();
  await expect(noted.getByTestId("ayah-footnote")).toBeVisible();
  expect(squash(await noted.getByTestId("ayah-footnote").innerText())).toContain(squash(aya.footnotes).slice(0, 40));
  await expect(page.locator("video")).toHaveCount(0);
  for (const media of await page.locator("audio").all()) {
    expect(await media.getAttribute("src")).toBeNull();
    await expect(media).toHaveAttribute("preload", "none");
  }
  await expect(page.getByTestId("source-link").first()).toHaveAttribute("href", /^https:\/\/(www\.)?quranenc\.com\//);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, info.project.name, "surah-reader");

  if ((quran.tafsir as Json[]).length > 0) {
    await expect(page.getByTestId("tafsir-credit")).toContainText("مجمع الملك فهد لطباعة المصحف الشريف");
    await expect(page.getByTestId("tafsir-credit")).toContainText("الإصدار");
    await page.getByTestId("tafsir-toggle").check();
    await expect(page).toHaveURL(/tafsir=1/);
    await expect(page.getByTestId("ayah-tafsir").first()).toContainText("وليس ترجمة");
  } else {
    await expect(page.getByTestId("tafsir-toggle")).toHaveCount(0);
  }

  await page.getByTestId("reading-language").selectOption("ar");
  await expect(page.getByTestId("surah-body")).toHaveAttribute("data-locale", "ar");
  await expect(page.getByTestId("ayah-translation")).toHaveCount(0);

  const longest = [...(quran.surahs as Json[])].sort((a, b) => b.ayah_count - a.ayah_count)[0];
  const full = await api(page, `/api/library/quran/${longest.number}?locale=en`);
  await page.goto(`/library/quran/${longest.number}?lang=en`);
  await expect(page.getByTestId("ayah")).toHaveCount(longest.ayah_count, { timeout: 15000 });
  const last = page.getByTestId("ayah").last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeVisible();
  expect(squash(await last.getByTestId("ayah-arabic").innerText())).toBe(squash(full.ayahs.at(-1).arabic));
  expect(squash(await last.getByTestId("ayah-translation").innerText())).toBe(squash(full.ayahs.at(-1).translation));
});

test("race: a late surah never replaces the newer one, and a late failure shows no error", async ({ page }) => {
  const quran = await api(page, "/api/library/quran");
  const [a, b, c] = quran.surahs as Json[];
  const bData = await api(page, `/api/library/quran/${b.number}?locale=en`);
  const late = hold(page, (u) => u.pathname === `/api/library/quran/${a.number}`);
  await late.ready;
  await page.goto(`/library/quran/${a.number}?lang=en`);
  await expect(page.getByTestId("library-loading")).toContainText(a.name_ar);
  await page.getByTestId("surah-next").click();
  await expect(page).toHaveURL(new RegExp(`/library/quran/${b.number}\\?`));
  await expect(page.getByTestId("surah-reader")).toHaveAttribute("data-number", String(b.number));
  expect(late.box.seen).toBeGreaterThan(0);
  await late.release();
  await page.waitForTimeout(600);
  await expect(page.getByTestId("surah-reader")).toHaveAttribute("data-number", String(b.number));
  await expect(page.getByRole("heading", { level: 1 })).toContainText(b.name_ar);
  await expect(page.getByTestId("ayah")).toHaveCount(b.ayah_count);
  expect(squash(await page.getByTestId("ayah-arabic").first().innerText())).toBe(squash(bData.ayahs[0].arabic));

  if (!c) return;
  const failing = hold(page, (u) => u.pathname === `/api/library/quran/${b.number}` && u.searchParams.get("locale") === "fr");
  await failing.ready;
  await page.getByTestId("reading-language").selectOption("fr");
  await expect(page.getByTestId("library-loading")).toContainText(b.name_ar);
  await page.getByTestId("surah-next").click();
  await expect(page.getByTestId("surah-reader")).toHaveAttribute("data-number", String(c.number));
  expect(failing.box.seen).toBeGreaterThan(0);
  await failing.fail();
  await page.waitForTimeout(600);
  await expect(page.getByTestId("library-error")).toHaveCount(0);
  await expect(page.getByTestId("surah-reader")).toHaveAttribute("data-number", String(c.number));
  await expect(page.getByTestId("ayah")).toHaveCount(c.ayah_count);
});

test("race: a held question that later fails shows no error under the newer question", async ({ page }) => {
  const list = await api(page, "/api/library/fatwas?page=1&page_size=20");
  const [x, y] = list.items as Json[];
  const late = hold(page, (u) => u.pathname === `/api/library/fatwas/${x.id}`);
  await late.ready;
  await page.goto("/library/questions");
  await page.locator(`[data-testid=item-link][data-id="${x.id}"]`).click();
  await expect(page.getByTestId("library-loading")).toContainText(x.title);
  await page.getByTestId("back-link").click();
  await page.locator(`[data-testid=item-link][data-id="${y.id}"]`).click();
  await expect(page.getByTestId("item-title")).toHaveText(y.title);
  expect(late.box.seen).toBeGreaterThan(0);
  await late.fail();
  await page.waitForTimeout(600);
  await expect(page.getByTestId("library-error")).toHaveCount(0);
  await expect(page.getByTestId("item-title")).toHaveText(y.title);
  await expect(page.getByTestId("fatwa-reader")).toHaveAttribute("data-id", y.id);
  await expect(page.getByText(x.title, { exact: true })).toHaveCount(0);
});

test("race: switching the reading language while the first language is held shows only the latest language", async ({
  page,
}) => {
  const rec = await hadithWith(page, ["en", "fr"]);
  const late = hold(
    page,
    (u) => u.pathname === `/api/library/hadith/${rec.id}` && u.searchParams.get("locale") === "en",
  );
  await late.ready;
  await page.goto(`/library/hadith/${encodeURIComponent(rec.id)}?lang=en`);
  await expect(page.getByTestId("library-loading")).toBeVisible();
  await page.getByTestId("reading-language").selectOption("fr");
  await expect(page.getByTestId("hadith-translation")).toHaveAttribute("lang", "fr");
  expect(late.box.seen).toBeGreaterThan(0);
  await late.release();
  await page.waitForTimeout(600);
  await expect(page).toHaveURL(/lang=fr/);
  await expect(page.getByTestId("hadith-translation")).toHaveAttribute("lang", "fr");
  await expect(page.getByTestId("hadith-reader").locator('[lang="en"]:not(option)')).toHaveCount(0);
  await expect(page.getByTestId("library-error")).toHaveCount(0);
});

test("reading the library never changes the open lesson, its acknowledgment or the learner's progress", async ({
  page,
}, info) => {
  const mobile = info.project.name.startsWith("mobile");
  await page.goto("/");
  await page.getByRole("button", { name: "جرّب درسًا" }).click();
  await expect(page).toHaveURL(/\/preview$/);
  await mainNav(page).getByRole("link", { name: "المراجعة", exact: true }).click();
  if (mobile) await page.getByRole("tab", { name: "الإقرار" }).click();
  const panel = page.getByTestId("ack-panel");
  await panel.getByLabel("اسمك أو وسمك").fill("G4-A library tester");
  await panel.getByLabel("قارنت هذه النسخة بالمصدر").check();
  await panel.getByRole("button", { name: "أقرّ هذه النسخة" }).click();
  await expect.poll(() => page.getByTestId("review-status").first().getAttribute("data-status")).toBe("acknowledged_by_user");
  await page.goto("/preview");
  await page.getByTestId("mark-read").click();
  await page.waitForTimeout(400);
  const progressText = await page.getByTestId("progress-count").innerText();
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
  expect(before[WS]).toBeTruthy();
  expect(before[PROGRESS]).toBeTruthy();

  await mainNav(page).getByRole("link", { name: "المكتبة", exact: true }).click();
  await page.getByTestId("collection-quran").click();
  await page.getByTestId("reading-language").selectOption("en");
  await page.getByTestId("surah-link").first().click();
  await expect(page.getByTestId("ayah").first()).toBeVisible();
  await page.getByTestId("surah-next").click();
  await page.getByTestId("reading-language").selectOption("ur");
  await expect(page.getByTestId("surah-body")).toHaveAttribute("data-locale", "ur");
  await mainNav(page).getByRole("link", { name: "المكتبة", exact: true }).click();
  await page.getByTestId("collection-questions").click();
  await page.getByRole("button", { name: "العقيدة", exact: true }).click();
  await page.getByTestId("library-search").fill("الله");
  await page.getByTestId("library-search").press("Enter");
  await page.getByRole("button", { name: "كل الموضوعات", exact: true }).click();
  await page.getByRole("button", { name: "امسح البحث" }).click();
  await page.getByTestId("item-link").first().click();
  await expect(page.getByTestId("item-title")).toBeVisible();
  await page.getByTestId("reading-language").selectOption("fr");
  // Either the honest unavailable message or the stored AI-assisted translation, never a silent blank.
  await expect(page.getByTestId("translation-unavailable").or(page.getByTestId("fatwa-mt"))).toBeVisible();
  await mainNav(page).getByRole("link", { name: "المكتبة", exact: true }).click();
  await page.getByTestId("collection-hadith").click();
  await page.getByTestId("item-link").first().click();
  await expect(page.getByTestId("item-title")).toBeVisible();
  await page.goBack();
  await page.waitForTimeout(400);

  expect(await snapshot()).toEqual(before);
  await page.goto("/preview");
  await expect(page.getByTestId("lesson")).toBeVisible();
  await expect(page.getByTestId("progress-count")).toHaveText(progressText);
  await expect(page.getByTestId("review-status").first()).toHaveAttribute("data-status", "acknowledged_by_user");
  expect(await snapshot()).toEqual(before);
});

test("reading a surah, a question and a hadith sends no request outside this server", async ({ page }) => {
  const external: string[] = [];
  await page.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === "127.0.0.1" || host === "localhost") return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  const { surah, locale } = await footnoteSurah(page);
  const fatwas = await api(page, "/api/library/fatwas?page=1&page_size=1");
  const hadith = await hadithWith(page, ["en"]);

  await page.goto(`/library/quran/${surah.number}?lang=${locale}`);
  await expect(page.getByTestId("ayah")).toHaveCount(surah.ayah_count);
  await expect(page.getByTestId("ayah-translation").first()).toBeVisible();
  await page.goto(`/library/questions/${encodeURIComponent(fatwas.items[0].id)}`);
  await expect(page.getByTestId("item-title")).toHaveText(fatwas.items[0].title);
  await expect(page.getByTestId("source-link").first()).toBeVisible();
  await page.goto(`/library/hadith/${encodeURIComponent(hadith.id)}?lang=en`);
  await expect(page.getByTestId("hadith-translation")).toBeVisible();
  await expect(page.getByTestId("source-link").first()).toBeVisible();
  await page.waitForTimeout(300);
  expect(external).toEqual([]);
});
