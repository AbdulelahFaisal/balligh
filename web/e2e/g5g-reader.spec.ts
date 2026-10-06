import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Real AI-assisted translation artifacts only: nothing here stubs a translation into the reader.
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/review/G5-G/reader");
mkdirSync(OUT, { recursive: true });

const OTHER_LOCALES = ["en", "ur", "zh-Hans", "id", "bn", "fr"];
const NAMES: Record<string, string> = { ar: "العربية", en: "English", ur: "اردو", "zh-Hans": "简体中文", id: "Bahasa Indonesia", bn: "বাংলা", fr: "Français" };

type Run = { kind: string; text: string; note?: string; published?: unknown };
type Mt = { locale: string; label: string; title: string; question: Run[][]; answer: Run[][]; notes?: { id: string; paragraphs: Run[][] }[] };
type Detail = { record: { id: string; title: string; notes?: { id: string }[] | null }; machine_translation: Mt | null; machine_locales?: string[] };

const fatwa = async (request: APIRequestContext, id: string, locale: string): Promise<Detail> =>
  (await request.get(`/api/library/fatwas/${id}?locale=${locale}`)).json();

function watchProviders(page: Page): string[] {
  const hits: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/api/assistant/ask") || u.includes("/api/drafts/generate")) hits.push(u);
  });
  return hits;
}

const duplicateIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const seen = new Map<string, number>();
    document.querySelectorAll("[id]").forEach((el) => seen.set(el.id, (seen.get(el.id) ?? 0) + 1));
    return [...seen].filter(([id, n]) => id !== "" && n > 1).map(([id]) => id);
  });

const disclosureOpen = (page: Page): Promise<boolean> =>
  page.getByTestId("fatwa-original-disclosure").evaluate((el) => (el as HTMLDetailsElement).open);

/** Waits until a (possibly smooth) scroll has stopped, so that a screenshot shows the final position. */
async function settled(page: Page): Promise<void> {
  let last = -1;
  await expect
    .poll(
      async () => {
        const y = await page.evaluate(() => Math.round(window.scrollY));
        const same = y === last;
        last = y;
        return same;
      },
      { intervals: [250] },
    )
    .toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
});

for (const [id, locale] of [
  ["binbaz-18975", "ur"],
  ["binbaz-11423", "en"],
  ["binbaz-1157", "en"],
] as const) {
  test(`translated view ${id}/${locale}: one label, one source footer, visible anchors, accurate wording, unique ids`, async ({ page, request }, info) => {
    const api = await fatwa(request, id, locale);
    expect(api.machine_translation, `real AI-assisted artifact for ${id}/${locale}`).toBeTruthy();
    expect(api.machine_locales ?? []).toContain(locale);
    const hits = watchProviders(page);
    await page.goto(`/library/questions/${id}?lang=${locale}`);
    await expect(page.getByTestId("fatwa-reader")).toHaveAttribute("data-view", "machine");
    await expect(page.getByTestId("item-title")).toHaveText(api.machine_translation!.title);
    await expect(page.getByTestId("item-title-ar")).toHaveText(api.record.title);
    await expect(page.getByTestId("mt-label")).toHaveCount(1);
    await expect(page.getByTestId("reader-source")).toHaveCount(1);
    await expect(page.getByTestId("translation-unavailable")).toHaveCount(0);
    await expect(page.getByTestId("mt-available-locales")).toHaveCount(0);
    await expect(page.locator("#fatwa-mt-question")).toBeVisible();
    await expect(page.locator("#fatwa-mt-answer")).toBeVisible();
    // The Arabic original keeps its own ids inside the closed disclosure.
    expect(await disclosureOpen(page)).toBe(false);
    await expect(page.locator("#fatwa-question")).toBeHidden();
    await expect(page.locator("#fatwa-answer")).toBeHidden();
    // Helper wording: the original is under the disclosure, in the words the disclosure itself uses.
    const summary = ((await page.getByTestId("fatwa-original-disclosure").locator("summary").textContent()) ?? "").trim();
    expect(summary.length).toBeGreaterThan(0);
    await expect(page.getByTestId("reading-language-hint")).toContainText(summary);
    const text = (await page.getByTestId("fatwa-reader").innerText()).toLowerCase();
    expect(text).not.toContain("always shown");
    expect(text).not.toContain("يُعرض الأصل العربي دائم");
    expect(text).not.toContain("not reviewed");
    expect(await duplicateIds(page)).toEqual([]);
    await page.screenshot({ path: `${OUT}/${info.project.name}-${id}-${locale}.png`, fullPage: true });
    await page.getByTestId("fatwa-original-disclosure").locator("summary").click();
    await expect(page.locator("#fatwa-question")).toBeVisible();
    await expect(page.locator("#fatwa-answer")).toBeVisible();
    expect(await duplicateIds(page)).toEqual([]);
    expect(hits).toEqual([]);
  });
}

test("translated notes keep the original numbers; each marker links to its translated note and back", async ({ page, request }, info) => {
  const id = "binbaz-1157";
  const api = await fatwa(request, id, "en");
  const mt = api.machine_translation;
  expect(mt, "real AI-assisted artifact for binbaz-1157/en").toBeTruthy();
  const original = (api.record.notes ?? []).map((n) => n.id);
  const noteIds = (mt!.notes ?? []).map((n) => n.id);
  expect(noteIds.length).toBeGreaterThan(0);
  for (const n of noteIds) expect(original).toContain(n);
  const runs = [...mt!.question, ...mt!.answer].flat();
  const referenced = [...new Set(runs.filter((r) => r.kind === "noteref" && typeof r.note === "string" && noteIds.includes(r.note)).map((r) => r.note!))];
  expect(referenced.length, "translated text keeps note markers").toBeGreaterThan(0);

  const hits = watchProviders(page);
  await page.goto(`/library/questions/${id}?lang=en`);
  const view = page.getByTestId("fatwa-mt");
  await expect(view).toBeVisible();
  const notes = view.getByTestId("mt-note");
  await expect(notes).toHaveCount(noteIds.length);
  for (let i = 0; i < noteIds.length; i += 1) {
    await expect(notes.nth(i)).toHaveAttribute("data-note", noteIds[i]);
    await expect(notes.nth(i).getByTestId("mt-note-number")).toHaveText(`[${noteIds[i]}]`);
    await expect(notes.nth(i)).toHaveAttribute("id", `note-mt-${id}-${noteIds[i]}`);
  }
  if (runs.some((r) => r.kind === "quran" && r.published)) expect(await view.getByTestId("mt-published").count()).toBeGreaterThan(0);
  expect(await duplicateIds(page)).toEqual([]);

  // Marker -> translated note (the Arabic original stays closed).
  const first = referenced[0];
  const marker = view.locator(`[id="noteref-mt-${id}-${first}"]`);
  await expect(marker).toHaveAttribute("href", `#note-mt-${id}-${first}`);
  await marker.click();
  const note = view.locator(`[id="note-mt-${id}-${first}"]`);
  await expect(note).toBeInViewport();
  await expect(page).toHaveURL(new RegExp(`#note-mt-${id}-${first}$`));
  expect(await disclosureOpen(page)).toBe(false);
  await page.screenshot({ path: `${OUT}/${info.project.name}-note-target.png`, fullPage: false });
  // Translated note -> back to its marker.
  const back = note.getByTestId("mt-note-back");
  await expect(back).toHaveAttribute("href", `#noteref-mt-${id}-${first}`);
  await back.click();
  await expect(marker).toBeInViewport();
  await expect(page).toHaveURL(new RegExp(`#noteref-mt-${id}-${first}$`));
  // Every referenced note has exactly one back-link target in the translated view.
  for (const n of referenced) {
    await expect(view.locator(`[id="noteref-mt-${id}-${n}"]`)).toHaveCount(1);
    await expect(view.locator(`[id="note-mt-${id}-${n}"]`).getByTestId("mt-note-back")).toHaveCount(1);
  }

  // The Arabic original keeps its own working note links next to the translated ones.
  await page.getByTestId("fatwa-original-disclosure").locator("summary").click();
  const arabic = page.getByTestId("item-original");
  await expect(arabic).toBeVisible();
  expect(await duplicateIds(page)).toEqual([]);
  const arMarker = arabic.getByTestId("noteref").first();
  const arHref = (await arMarker.getAttribute("href")) ?? "";
  expect(arHref).toMatch(new RegExp(`^#note-${id}-`));
  await arMarker.click();
  await expect(page.locator(`[id="${arHref.slice(1)}"]`)).toBeInViewport();
  expect(await disclosureOpen(page)).toBe(true);
  expect(hits).toEqual([]);
});

test("Save my place in the translated view is restored on the visible translated answer after a reload", async ({ page, request }, info) => {
  const id = "binbaz-18975";
  expect((await fatwa(request, id, "ur")).machine_translation, "real AI-assisted artifact for binbaz-18975/ur").toBeTruthy();
  const hits = watchProviders(page);
  await page.goto(`/library/questions/${id}?lang=ur`);
  await expect(page.getByTestId("fatwa-mt")).toBeVisible();
  const save = page.getByTestId("reader-save").getByTestId("save-place");
  await expect(save).toHaveAttribute("data-anchor", "fatwa-question");
  await page.locator("#fatwa-mt-answer").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(save).toHaveAttribute("data-anchor", "fatwa-answer");
  await save.click();
  await expect(page.getByTestId("reader-save").getByTestId("save-place-status")).not.toHaveText("");

  await page.reload();
  await expect(page.getByTestId("fatwa-mt")).toBeVisible();
  await page.goto("/learn");
  const link = page.getByTestId("continue-link");
  await expect(link).toHaveAttribute("href", new RegExp(`${id}\\?lang=ur#fatwa-answer$`));
  await link.click();
  const target = page.locator("#fatwa-mt-answer");
  await expect(target).toBeInViewport();
  await expect(target).toBeFocused();
  await expect(page.getByTestId("restore-fallback")).toHaveCount(0);
  // Never into the closed disclosure.
  expect(await disclosureOpen(page)).toBe(false);
  await expect(page.locator("#fatwa-answer")).toBeHidden();
  expect(await duplicateIds(page)).toEqual([]);
  await settled(page);
  await expect(target).toBeInViewport();
  await page.screenshot({ path: `${OUT}/${info.project.name}-restored.png`, fullPage: false });

  // A direct link to the saved place survives a reload in the translated view as well.
  await page.reload();
  await expect(page.locator("#fatwa-mt-answer")).toBeFocused();
  await expect(page.locator("#fatwa-mt-answer")).toBeInViewport();
  expect(await disclosureOpen(page)).toBe(false);
  expect(hits).toEqual([]);
});

test("a link to an original note resolves to the visible translated note, never into the closed disclosure", async ({ page, request }) => {
  const id = "binbaz-1157";
  const api = await fatwa(request, id, "en");
  const noteId = (api.machine_translation?.notes ?? [])[0]?.id;
  expect(noteId, "binbaz-1157/en has a translated note").toBeTruthy();
  await page.goto(`/library/questions/${id}?lang=en#note-${id}-${noteId}`);
  await expect(page.getByTestId("fatwa-reader")).toHaveAttribute("data-view", "machine");
  const target = page.locator(`[id="note-mt-${id}-${noteId}"]`);
  await expect(target).toBeFocused();
  await expect(target).toBeInViewport();
  expect(await disclosureOpen(page)).toBe(false);
  await expect(page.getByTestId("restore-fallback")).toHaveCount(0);
});

test("a link to an original note that has no translated counterpart opens the Arabic original", async ({ page, request }) => {
  const id = "binbaz-1157";
  const api = await fatwa(request, id, "en");
  const noteId = (api.record.notes ?? [])[0]?.id;
  expect(noteId, "binbaz-1157 has an Arabic note").toBeTruthy();
  // The real response, with only its translated notes withheld: the note then exists in the Arabic original alone.
  await page.route(`**/api/library/fatwas/${id}?locale=en*`, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (body.machine_translation) body.machine_translation.notes = [];
    await route.fulfill({ response: res, json: body });
  });
  await page.goto(`/library/questions/${id}?lang=en#note-${id}-${noteId}`);
  await expect(page.getByTestId("fatwa-reader")).toHaveAttribute("data-view", "machine");
  await expect(page.getByTestId("mt-note")).toHaveCount(0);
  const target = page.locator(`[id="note-${id}-${noteId}"]`);
  await expect(target).toBeVisible();
  await expect(target).toBeFocused();
  await expect(target).toBeInViewport();
  expect(await disclosureOpen(page)).toBe(true);
  await expect(page.getByTestId("restore-fallback")).toHaveCount(0);
  expect(await duplicateIds(page)).toEqual([]);
  // The reader can still close it again.
  await page.getByTestId("fatwa-original-disclosure").locator("summary").click();
  expect(await disclosureOpen(page)).toBe(false);
  await expect(target).toBeHidden();
});

test("a language without a translation lists the languages that do have an AI-assisted one", async ({ page, request }, info) => {
  // Prefer a real gap; when every sampled fatwa is translated everywhere, withhold one language from the real response.
  let pick: { id: string; missing: string; others: string[]; real: boolean } | null = null;
  const have = new Map<string, Set<string>>();
  for (const locale of OTHER_LOCALES) {
    for (let p = 1; p <= 12; p += 1) {
      const list = await (await request.get(`/api/library/fatwas?locale=${locale}&page=${p}&page_size=50`)).json();
      const items = (list.items ?? []) as { id: string; machine_translated?: boolean }[];
      for (const i of items) {
        if (!have.has(i.id)) have.set(i.id, new Set());
        if (i.machine_translated === true) have.get(i.id)!.add(locale);
      }
      if (items.length === 0 || p * 50 >= (list.total ?? 0)) break;
    }
  }
  for (const [candidate, locales] of have) {
    if (pick || locales.size === 0 || locales.size === OTHER_LOCALES.length) continue;
    const missing = OTHER_LOCALES.find((l) => !locales.has(l))!;
    const d = await fatwa(request, candidate, missing);
    const others = (d.machine_locales ?? []).filter((l) => l !== missing && l !== "ar" && l in NAMES);
    if (!d.machine_translation && others.length > 0) pick = { id: candidate, missing, others, real: true };
  }
  console.log(`G5G fatwas listed: ${have.size}; translated in all ${OTHER_LOCALES.length} languages: ${[...have.values()].filter((s) => s.size === OTHER_LOCALES.length).length}; in none: ${[...have.values()].filter((s) => s.size === 0).length}`);
  if (!pick) {
    const d = await fatwa(request, "binbaz-11423", "en");
    const others = (d.machine_locales ?? []).filter((l) => l !== "en" && l !== "ar" && l in NAMES);
    expect(others.length, "binbaz-11423 has AI-assisted translations in other languages").toBeGreaterThan(0);
    pick = { id: "binbaz-11423", missing: "en", others, real: false };
    await page.route(`**/api/library/fatwas/${pick.id}?locale=en*`, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.machine_translation = null;
      body.machine_locales = (body.machine_locales ?? []).filter((l: string) => l !== "en");
      await route.fulfill({ response: res, json: body });
    });
  }
  info.annotations.push({ type: "gap", description: `${pick.real ? "real" : "withheld"} ${pick.id}/${pick.missing} -> ${pick.others.join(",")}` });
  console.log(`G5G gap case: ${pick.real ? "real" : "withheld"} ${pick.id}/${pick.missing} others=${pick.others.join(",")}`);

  const hits = watchProviders(page);
  await page.goto(`/library/questions/${pick.id}?lang=${pick.missing}`);
  await expect(page.getByTestId("fatwa-reader")).toHaveAttribute("data-view", "original");
  await expect(page.getByTestId("translation-unavailable")).toBeVisible();
  const box = page.getByTestId("mt-available-locales");
  await expect(box).toBeVisible();
  await expect(box.getByTestId("mt-locale")).toHaveCount(pick.others.length);
  for (const l of pick.others) await expect(box.locator(`[data-testid="mt-locale"][data-locale="${l}"]`)).toHaveText(NAMES[l]);
  await expect(box.locator(`[data-locale="${pick.missing}"]`)).toHaveCount(0);
  await expect(page.getByTestId("mt-label")).toHaveCount(0);
  await expect(page.getByTestId("fatwa-original-disclosure")).toHaveCount(0);
  await expect(page.getByTestId("item-original")).toBeVisible();
  expect(await duplicateIds(page)).toEqual([]);
  await page.screenshot({ path: `${OUT}/${info.project.name}-unavailable-lists-languages.png`, fullPage: false });

  // Choosing one of them opens that real translation.
  const next = pick.others[0];
  await box.locator(`[data-testid="mt-locale"][data-locale="${next}"]`).click();
  await expect(page).toHaveURL(new RegExp(`lang=${next}`));
  await expect(page.getByTestId("fatwa-reader")).toHaveAttribute("data-view", "machine");
  await expect(page.getByTestId("mt-label")).toHaveCount(1);
  await expect(page.getByTestId("mt-available-locales")).toHaveCount(0);

  // A fatwa that has no AI-assisted translation at all offers no such list: only Arabic exists, and the page says so.
  const none = [...have].find(([, s]) => s.size === 0)?.[0];
  if (none && ((await fatwa(request, none, "en")).machine_locales ?? []).length === 0) {
    console.log(`G5G untranslated case: ${none}`);
    await page.goto(`/library/questions/${none}?lang=en`);
    await expect(page.getByTestId("translation-unavailable")).toBeVisible();
    await expect(page.getByTestId("item-original")).toBeVisible();
    await expect(page.getByTestId("mt-available-locales")).toHaveCount(0);
  }
  expect(hits).toEqual([]);
});

test("Learn path: a translated fatwa shows its translated title and real availability, never Arabic only", async ({ page, request }, info) => {
  const path = await (await request.get("/api/learn/stages")).json();
  type Entry = { collection: string; source_id: string; title: string; languages: string[]; machine_languages?: string[]; translated_titles?: Record<string, string> };
  let pick: { stage: number; position: number; entry: Entry } | null = null;
  for (const s of path.stages as { order: number; entries: Entry[] }[])
    s.entries.forEach((e, i) => {
      if (!pick && e.collection === "fatwa" && (e.machine_languages ?? []).includes("en") && e.translated_titles?.en) pick = { stage: s.order, position: i + 1, entry: e };
    });
  expect(pick, "a stage fatwa with a real English AI-assisted translation").toBeTruthy();
  const { stage, position, entry } = pick!;
  expect(entry.languages).toEqual(["ar"]);

  const hits = watchProviders(page);
  await page.goto(`/learn?stage=${stage}`);
  await page.locator("header select").selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  const card = page.locator(`[data-testid="stage-entry"][data-collection="fatwa"][data-id="${entry.source_id}"]`).first();
  await expect(card).toBeVisible();
  await expect(card.getByTestId("entry-translated-title")).toHaveText(entry.translated_titles!.en.trim());
  await expect(card.getByTestId("entry-translated-title")).toHaveAttribute("data-locale", "en");
  await expect(card.getByTestId("entry-original-title")).toHaveText(entry.title);
  await expect(card).not.toContainText("Arabic only");
  await expect(card.getByTestId("entry-languages")).toHaveText(`Languages: ${NAMES.ar}`);
  const machine = card.getByTestId("entry-machine-languages");
  await expect(machine).toContainText("AI-assisted translation:");
  for (const l of entry.machine_languages!.filter((x) => x in NAMES && x !== "ar")) await expect(machine).toContainText(NAMES[l]);
  // Every fatwa card tells the truth: "Arabic only" exactly when no AI-assisted language exists.
  const fatwas = (path.stages as { order: number; entries: Entry[] }[])[stage - 1].entries.filter((e) => e.collection === "fatwa");
  for (const e of fatwas) {
    const c = page.locator(`[data-testid="stage-entry"][data-collection="fatwa"][data-id="${e.source_id}"]`).first();
    const hasMachine = (e.machine_languages ?? []).some((l) => l in NAMES && l !== "ar");
    await expect(c.getByTestId("entry-machine-languages")).toHaveCount(hasMachine ? 1 : 0);
    if (hasMachine) await expect(c).not.toContainText("Arabic only");
    else await expect(c.getByTestId("entry-languages")).toHaveText("Arabic only");
  }
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/${info.project.name}-learn-stage.png`, fullPage: false });

  // Navigation, context link and explicit completion are unchanged.
  await expect(card.getByTestId("stage-entry-link")).toHaveAttribute(
    "href",
    `/library/questions/${entry.source_id}?lang=en&path=introductory-reading&stage=${stage}&entry=${position}`,
  );
  const mark = card.getByTestId("mark-read");
  await expect(mark).toHaveAttribute("aria-pressed", "false");
  await mark.click();
  await expect(mark).toHaveAttribute("aria-pressed", "true");
  await expect(card).toHaveAttribute("data-read", "true");
  await mark.click();
  await expect(card).toHaveAttribute("data-read", "false");
  await card.getByTestId("stage-entry-link").click();
  await expect(page.getByTestId("fatwa-reader")).toHaveAttribute("data-view", "machine");
  await expect(page.getByTestId("item-title")).toHaveText(entry.translated_titles!.en.trim());
  expect(hits).toEqual([]);
});

test("fatwa list: an AI-assisted title is shown with the Arabic title as secondary text", async ({ page, request }) => {
  const list = await (await request.get("/api/library/fatwas?locale=en&page=1&page_size=20")).json();
  const hit = (list.items as { id: string; title: string; translated_title: string | null; machine_translated?: boolean }[]).find(
    (i) => i.machine_translated === true && !!i.translated_title,
  );
  expect(hit, "a first-page fatwa with a real English AI-assisted title").toBeTruthy();
  await page.goto("/library/questions?lang=en");
  const link = page.locator(`[data-testid="item-link"][data-id="${hit!.id}"]`);
  await expect(link).toBeVisible();
  await expect(link.locator('span[lang="en"]').first()).toHaveText(hit!.translated_title!);
  await expect(link.locator('span[lang="ar"]').first()).toHaveText(hit!.title);
});
