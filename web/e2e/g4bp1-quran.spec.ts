import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/review/G4-B-P2/quran");
mkdirSync(OUT, { recursive: true });

function stubMedia() {
  type S = { t: number; ready: number; paused: boolean; timer: number | null; src: string };
  const ctl = {
    log: [] as string[],
    metaDelay: 20,
    step: 5,
    holdPlay: false,
    holdSeek: false,
    held: [] as { ok: () => void; fail: () => void }[],
    seeks: [] as (() => void)[],
    live: {} as Record<string, number>,
  };
  const st = new WeakMap<HTMLMediaElement, S>();
  const get = (el: HTMLMediaElement) => {
    let s = st.get(el);
    if (!s) {
      s = { t: 0, ready: 0, paused: true, timer: null, src: "" };
      st.set(el, s);
    }
    return s;
  };
  const stopClock = (s: S) => {
    if (s.timer !== null) window.clearInterval(s.timer);
    s.timer = null;
  };
  const P = HTMLMediaElement.prototype;
  const add = P.addEventListener;
  const remove = P.removeEventListener;
  P.addEventListener = function (this: HTMLMediaElement, type: string, fn: never, o?: never) {
    ctl.live[type] = (ctl.live[type] ?? 0) + 1;
    return add.call(this, type, fn, o);
  } as typeof P.addEventListener;
  P.removeEventListener = function (this: HTMLMediaElement, type: string, fn: never, o?: never) {
    ctl.live[type] = (ctl.live[type] ?? 0) - 1;
    return remove.call(this, type, fn, o);
  } as typeof P.removeEventListener;
  Object.defineProperty(P, "currentTime", {
    configurable: true,
    get() {
      return get(this).t;
    },
    set(v: number) {
      const s = get(this);
      s.t = v;
      ctl.log.push(`seek ${s.src.split("/").pop()} ${v}`);
      const fire = () => this.dispatchEvent(new Event("seeked"));
      if (ctl.holdSeek) ctl.seeks.push(fire);
      else window.setTimeout(fire, 10);
    },
  });
  Object.defineProperty(P, "readyState", { configurable: true, get() { return get(this).ready; } });
  Object.defineProperty(P, "paused", { configurable: true, get() { return get(this).paused; } });
  Object.defineProperty(P, "ended", { configurable: true, get() { return false; } });
  P.load = function () {
    const s = get(this);
    stopClock(s);
    s.paused = true;
    s.ready = 0;
    s.t = 0;
    s.src = this.getAttribute("src") ?? "";
    const src = s.src;
    ctl.log.push(`load ${src.split("/").pop()}`);
    window.setTimeout(() => {
      if (get(this).src !== src) return;
      s.ready = 1;
      this.dispatchEvent(new Event("loadedmetadata"));
    }, ctl.metaDelay);
  };
  const run = (el: HTMLMediaElement, s: S) => {
    s.paused = false;
    stopClock(s);
    s.timer = window.setInterval(() => {
      s.t += ctl.step;
      el.dispatchEvent(new Event("timeupdate"));
    }, 50);
  };
  P.play = function () {
    const s = get(this);
    ctl.log.push(`play ${s.src.split("/").pop()} ${s.t}`);
    if (ctl.holdPlay) {
      return new Promise<void>((ok, fail) => {
        ctl.held.push({
          ok: () => {
            run(this, s);
            ok();
          },
          fail: () => fail(new DOMException("held then aborted", "AbortError")),
        });
      });
    }
    run(this, s);
    return Promise.resolve();
  };
  P.pause = function () {
    const s = get(this);
    if (!s.paused) ctl.log.push(`pause ${s.src.split("/").pop()} ${s.t}`);
    s.paused = true;
    stopClock(s);
  };
  (window as unknown as { __media: typeof ctl }).__media = ctl;
}

const setMedia = (page: Page, patch: Record<string, unknown>) =>
  page.evaluate((p) => Object.assign((window as any).__media, p), patch);
const media = (page: Page) => page.evaluate(() => (window as any).__media.log as string[]);
const paused = (page: Page) =>
  page.evaluate(() => document.querySelector<HTMLAudioElement>('[data-testid="quran-audio"]')!.paused);
const player = (page: Page) => page.getByTestId("quran-player");
const now = (page: Page) => page.getByTestId("quran-now");
const otherKeys = (page: Page) =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k !== "balligh.reading.v1")
      .sort()
      .map((k) => `${k}=${localStorage.getItem(k)}`),
  );

async function openSurah(page: Page, n: number) {
  await page.goto(`/library/quran/${n}?lang=en`);
  await expect(page.getByTestId("audio-status")).toContainText(/جاهز|Ready/);
}

async function choosePage583(page: Page) {
  await page.getByTestId("audio-mode-page").check();
  await page.getByTestId("audio-page").selectOption("583");
  await expect(page.getByTestId("audio-boundary")).toContainText("78:31");
}

test.describe("simulated media: page playback shows its own text", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(stubMedia);
  });

  for (const route of [78, 79]) {
    test(`page 583 from route ${route} shows 78:31, then 79:1, and stops after 79:16`, async ({ page }, info) => {
      await openSurah(page, route);
      const before = await otherKeys(page);
      await page.evaluate(() => {
        (window as any).__seen = [];
        const el = document.querySelector('[data-testid="quran-player"]')!;
        new MutationObserver(() => (window as any).__seen.push(el.getAttribute("data-now"))).observe(el, {
          attributes: true,
          attributeFilter: ["data-now"],
        });
      });
      await choosePage583(page);
      await setMedia(page, { step: 0 });
      await page.getByTestId("audio-play").click();
      await expect(player(page)).toHaveAttribute("data-phase", "playing");
      await expect(now(page)).toHaveAttribute("data-ref", "78:31");
      await expect(now(page).getByTestId("quran-now-arabic")).toHaveAttribute("lang", "ar");
      await expect(now(page).getByTestId("quran-now-arabic")).toHaveAttribute("dir", "rtl");
      await expect(now(page).getByTestId("quran-now-arabic")).not.toBeEmpty();
      await expect(now(page).getByTestId("quran-now-translation")).toHaveAttribute("lang", "en");
      await expect(now(page).getByTestId("quran-now-translation")).not.toBeEmpty();
      await expect(now(page).getByTestId("quran-now-edition")).not.toBeEmpty();
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("balligh.reading.v1") ?? ""))
        .toMatch(/"id":"78".*"anchor":"ayah-31"|"anchor":"ayah-31".*"id":"78"/);
      await page.screenshot({ path: `${OUT}/${info.project.name}-route${route}-583-78-31.png` });
      await setMedia(page, { holdSeek: true, step: 2 });
      await expect(now(page)).toHaveAttribute("data-ref", "79:1", { timeout: 15_000 });
      await setMedia(page, { holdSeek: false, step: 0 });
      await expect(now(page).getByTestId("quran-now-arabic")).not.toBeEmpty();
      await expect(now(page).getByTestId("quran-now-translation")).toHaveAttribute("lang", "en");
      await page.screenshot({ path: `${OUT}/${info.project.name}-route${route}-583-79-1.png` });
      await page.evaluate(() => (window as any).__media.seeks.forEach((f: () => void) => f()));
      await expect(player(page)).toHaveAttribute("data-phase", "playing");
      await setMedia(page, { step: 8 });
      await expect(player(page)).toHaveAttribute("data-phase", "ended", { timeout: 20_000 });
      const seen = (await page.evaluate(() => (window as any).__seen)) as string[];
      expect(seen).not.toContain("79:17");
      expect((await media(page)).filter((l) => l.startsWith("pause")).pop()).toMatch(/^pause 079\.mp3 /);
      expect(await otherKeys(page)).toEqual(before);
    });
  }

  test("a delayed old text response never replaces a newer selection; failures are honest", async ({ page }) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    await page.route("**/api/library/quran/78?**", async (r) => {
      await gate;
      await r.continue();
    });
    await openSurah(page, 79);
    await choosePage583(page);
    await setMedia(page, { step: 0 });
    await page.getByTestId("audio-play").click();
    await expect(now(page)).toHaveAttribute("data-ref", "78:31");
    await expect(now(page).getByTestId("quran-now-loading")).toBeVisible();
    await expect(now(page).getByTestId("quran-now-arabic")).toHaveCount(0);
    await setMedia(page, { holdSeek: true, step: 2 });
    await expect(now(page)).toHaveAttribute("data-ref", "79:1", { timeout: 15_000 });
    await setMedia(page, { holdSeek: false, step: 0 });
    release();
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__media.seeks.forEach((f: () => void) => f()));
    await expect(now(page)).toHaveAttribute("data-ref", "79:1");
    await expect(now(page).getByTestId("quran-now-arabic")).toBeVisible();
    await page.getByTestId("audio-stop").click();
    await page.unroute("**/api/library/quran/78?**");
    await page.route("**/api/library/quran/78?**", (r) => r.fulfill({ status: 500, body: "{}" }));
    await page.getByTestId("audio-play").click();
    await expect(now(page)).toHaveAttribute("data-ref", "78:31");
    await expect(now(page).getByTestId("quran-now-error")).toBeVisible();
    await expect(now(page).getByTestId("quran-now-arabic")).toHaveCount(0);
  });

  test("locale switch keeps the position and swaps only the translation; the player is not remounted", async ({ page }) => {
    await openSurah(page, 79);
    await page.evaluate(() => ((document.querySelector('[data-testid="quran-audio"]') as any).__mark = "kept"));
    await choosePage583(page);
    await setMedia(page, { step: 0 });
    await page.getByTestId("audio-play").click();
    await expect(now(page).getByTestId("quran-now-translation")).toHaveAttribute("lang", "en");
    const arabic = await now(page).getByTestId("quran-now-arabic").textContent();
    const english = await now(page).getByTestId("quran-now-translation").textContent();
    await page.getByTestId("reading-language").selectOption("ur");
    await expect(now(page).getByTestId("quran-now-translation")).toHaveAttribute("lang", "ur");
    expect(await now(page).getByTestId("quran-now-translation").textContent()).not.toBe(english);
    expect(await now(page).getByTestId("quran-now-arabic").textContent()).toBe(arabic);
    await expect(now(page)).toHaveAttribute("data-ref", "78:31");
    await expect(player(page)).toHaveAttribute("data-phase", "playing");
    const log = await media(page);
    expect(log.filter((l) => l.startsWith("load"))).toHaveLength(1);
    expect(log.filter((l) => l.startsWith("seek"))).toHaveLength(1);
    await page.getByTestId("audio-stop").click();
    await page.getByTestId("surah-next").click();
    await expect(page).toHaveURL(/\/library\/quran\/80/);
    await expect(page.getByTestId("audio-status")).toContainText(/جاهز|Ready/);
    expect(await page.evaluate(() => (document.querySelector('[data-testid="quran-audio"]') as any).__mark)).toBe("kept");
  });
});

test("an ayah anchor restores into view and a missing one shows a truthful fallback", async ({ page }) => {
  await page.goto("/library/quran/78?lang=en#ayah-31");
  await expect(page.locator("#ayah-31")).toBeInViewport();
  await expect(page.getByTestId("quran-restore-missing")).toHaveCount(0);
  await page.goto("/library/quran/114?lang=en#ayah-99");
  await expect(page.getByTestId("ayah")).toHaveCount(6);
  await expect(page.getByTestId("quran-restore-missing")).toBeVisible();
  await expect(page.getByTestId("quran-restore-missing")).toContainText("ayah-99");
});

test.describe("simulated media: pending operations belong to their own selection", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(stubMedia);
  });

  test("a held old play() fulfilment or rejection never pauses or errors a newer selection", async ({ page }) => {
    await openSurah(page, 78);
    await setMedia(page, { holdPlay: true, step: 0 });
    await page.locator('[data-aya="1"]').getByTestId("ayah-listen").click();
    await expect.poll(() => page.evaluate(() => (window as any).__media.held.length)).toBe(1);
    await page.locator('[data-aya="2"]').getByTestId("ayah-listen").click();
    await expect.poll(() => page.evaluate(() => (window as any).__media.held.length)).toBe(2);
    await setMedia(page, { holdPlay: false });
    await page.locator('[data-aya="5"]').getByTestId("ayah-listen").click();
    await expect(player(page)).toHaveAttribute("data-phase", "playing");
    await page.evaluate(() => (window as any).__media.held[0].ok());
    await page.evaluate(() => (window as any).__media.held[1].fail());
    await page.waitForTimeout(300);
    expect(await paused(page)).toBe(false);
    await expect(player(page)).toHaveAttribute("data-phase", "playing");
    await expect(player(page)).toHaveAttribute("data-now", "78:5");
    await expect(page.getByTestId("audio-status")).toContainText(/78/);
  });

  test("Stop during a held play() keeps the media stopped when it resolves late", async ({ page }) => {
    await openSurah(page, 78);
    await setMedia(page, { holdPlay: true, step: 0 });
    await page.locator('[data-aya="3"]').getByTestId("ayah-listen").click();
    await expect.poll(() => page.evaluate(() => (window as any).__media.held.length)).toBe(1);
    await page.getByTestId("audio-stop").click();
    await page.evaluate(() => (window as any).__media.held[0].ok());
    await page.waitForTimeout(300);
    expect(await paused(page)).toBe(true);
    await expect(player(page)).toHaveAttribute("data-phase", "idle");
    await expect(page.getByTestId("audio-status")).toContainText(/جاهز|Ready/);
  });

  test("Stop during a held seek releases its listeners and a late seeked never starts playback", async ({ page }) => {
    await openSurah(page, 78);
    await setMedia(page, { holdSeek: true, step: 0 });
    const base = (await page.evaluate(() => (window as any).__media.live.seeked ?? 0)) as number;
    await page.locator('[data-aya="31"]').getByTestId("ayah-listen").click();
    await expect.poll(() => page.evaluate(() => (window as any).__media.seeks.length)).toBe(1);
    expect(await page.evaluate(() => (window as any).__media.live.seeked)).toBe(base + 1);
    await page.getByTestId("audio-stop").click();
    expect(await page.evaluate(() => (window as any).__media.live.seeked)).toBe(base);
    await page.evaluate(() => (window as any).__media.seeks[0]());
    await page.waitForTimeout(300);
    expect((await media(page)).filter((l) => l.startsWith("play"))).toHaveLength(0);
    expect(await paused(page)).toBe(true);
    await expect(player(page)).toHaveAttribute("data-phase", "idle");
    await setMedia(page, { holdSeek: false });
    await page.locator('[data-aya="31"]').getByTestId("ayah-listen").click();
    await expect(player(page)).toHaveAttribute("data-phase", "playing");
    expect(await paused(page)).toBe(false);
  });
});
