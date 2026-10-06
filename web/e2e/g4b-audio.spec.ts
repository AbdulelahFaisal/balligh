import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../docs/review/G4-B-P2/audio");
mkdirSync(OUT, { recursive: true });

function stubMedia() {
  const ctl = {
    log: [] as string[],
    blockPlay: false,
    noMetadata: false,
    metaDelay: 20,
    step: 5,
    playing: 0,
  };
  const st = new WeakMap<HTMLMediaElement, { t: number; ready: number; paused: boolean; timer: number | null; src: string }>();
  const get = (el: HTMLMediaElement) => {
    let s = st.get(el);
    if (!s) {
      s = { t: 0, ready: 0, paused: true, timer: null, src: "" };
      st.set(el, s);
    }
    return s;
  };
  const stopClock = (s: { timer: number | null }) => {
    if (s.timer !== null) window.clearInterval(s.timer);
    s.timer = null;
  };
  const P = HTMLMediaElement.prototype;
  Object.defineProperty(P, "currentTime", {
    configurable: true,
    get() {
      return get(this).t;
    },
    set(v: number) {
      const s = get(this);
      s.t = v;
      ctl.log.push(`seek ${s.src.split("/").pop()} ${v}`);
      window.setTimeout(() => this.dispatchEvent(new Event("seeked")), 10);
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
      if (ctl.noMetadata) {
        this.dispatchEvent(new Event("error"));
        return;
      }
      s.ready = 1;
      this.dispatchEvent(new Event("loadedmetadata"));
    }, ctl.metaDelay);
  };
  P.play = function () {
    const s = get(this);
    if (ctl.blockPlay) {
      ctl.log.push("play blocked");
      return Promise.reject(new DOMException("blocked", "NotAllowedError"));
    }
    ctl.log.push(`play ${s.src.split("/").pop()} ${s.t}`);
    s.paused = false;
    stopClock(s);
    s.timer = window.setInterval(() => {
      s.t += ctl.step;
      this.dispatchEvent(new Event("timeupdate"));
    }, 50);
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

const media = (page: Page) => page.evaluate(() => (window as any).__media.log as string[]);
const setMedia = (page: Page, patch: Record<string, unknown>) =>
  page.evaluate((p) => Object.assign((window as any).__media, p), patch);
const player = (page: Page) => page.getByTestId("quran-player");

async function openSurah(page: Page, n: number) {
  await page.goto(`/library/quran/${n}?lang=en`);
  await expect(page.getByTestId("audio-status")).toContainText(/جاهز|Ready/);
}

test.describe("simulated media", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(stubMedia);
  });

  test("ayah start seeks to the verified time and highlights only that ayah", async ({ page }, info) => {
    await openSurah(page, 78);
    await expect(player(page)).toContainText("ياسر الدوسري");
    await expect(page.getByTestId("ayah-arabic").first()).toBeVisible();
    await expect(page.getByTestId("ayah-translation").first()).toBeVisible();
    await setMedia(page, { step: 0 });
    await page.locator('[data-aya="31"]').getByTestId("ayah-listen").click();
    await expect(player(page)).toHaveAttribute("data-phase", "playing");
    expect(await media(page)).toContain("seek 078.mp3 147.36");
    await expect(page.locator('[data-aya="31"]')).toHaveAttribute("data-active", "true");
    await expect(page.locator('[data-active="true"]')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("balligh.reading.v1") ?? "")).toContain('"anchor":"ayah-31"');
    await page.screenshot({ path: `${OUT}/${info.project.name}-ayah-78-31.png`, fullPage: false });
  });

  test("rapid selections stop old playback and ignore stale metadata events", async ({ page }) => {
    await openSurah(page, 78);
    await setMedia(page, { metaDelay: 300 });
    for (const n of [1, 5, 10]) await page.locator(`[data-aya="${n}"]`).getByTestId("ayah-listen").click();
    await expect(player(page)).toHaveAttribute("data-phase", "playing");
    const log = await media(page);
    const seeks = log.filter((l) => l.startsWith("seek"));
    expect(seeks).toHaveLength(1);
    expect(seeks[0]).toMatch(/^seek 078\.mp3 /);
    expect(log.filter((l) => l.startsWith("play"))).toHaveLength(1);
    await expect(player(page)).toHaveAttribute("data-now", /^78:1\d?$/);
    await expect(page.getByTestId("audio-ayah")).toHaveValue("10");
  });

  test("page 583 starts at 78:31, continues into the next surah and stops at the page end", async ({ page }, info) => {
    await openSurah(page, 78);
    await page.getByTestId("audio-mode-page").check();
    await page.getByTestId("audio-page").selectOption("583");
    await expect(page.getByTestId("audio-boundary")).toContainText("78:31");
    await setMedia(page, { step: 8 });
    await page.getByTestId("audio-play").click();
    await expect(player(page)).toHaveAttribute("data-phase", "ended", { timeout: 20_000 });
    const log = await media(page);
    expect(log).toContain("seek 078.mp3 147.36");
    expect(log).toContain("load 079.mp3");
    expect(log).toContain("seek 079.mp3 0.12");
    const last = log.filter((l) => l.startsWith("pause")).pop()!;
    expect(last).toMatch(/^pause 079\.mp3 /);
    await page.screenshot({ path: `${OUT}/${info.project.name}-page-583-ended.png`, fullPage: false });
  });

  test("missing metadata shows an honest error and keeps the text readable", async ({ page }) => {
    await openSurah(page, 114);
    await setMedia(page, { noMetadata: true });
    await page.getByTestId("audio-play").click();
    await expect(player(page)).toHaveAttribute("data-phase", "error");
    await expect(page.getByTestId("audio-status").getByRole("link")).toHaveAttribute("href", /mp3quran\.net/);
    await expect(page.getByTestId("ayah")).toHaveCount(6);
  });

  test("blocked play explains the extra tap and recovers on Play", async ({ page }) => {
    await openSurah(page, 1);
    await setMedia(page, { blockPlay: true });
    await page.getByTestId("audio-play").click();
    await expect(player(page)).toHaveAttribute("data-phase", "needsTap");
    await expect(page.getByTestId("audio-status")).toContainText(/ضغطة أخرى|another tap/);
    await setMedia(page, { blockPlay: false });
    await page.getByTestId("audio-play").click();
    await expect(player(page)).toHaveAttribute("data-phase", "playing");
  });

  test("locale change keeps the audio position", async ({ page }) => {
    await openSurah(page, 78);
    await setMedia(page, { step: 0.5 });
    await page.locator('[data-aya="2"]').getByTestId("ayah-listen").click();
    await expect(player(page)).toHaveAttribute("data-phase", "playing");
    await page.getByTestId("reading-language").selectOption("ur");
    await expect(page.getByTestId("surah-body")).toHaveAttribute("data-locale", "ur");
    await expect(player(page)).toHaveAttribute("data-phase", "playing");
    const log = await media(page);
    expect(log.filter((l) => l.startsWith("load"))).toHaveLength(1);
    expect(log.filter((l) => l.startsWith("seek"))).toHaveLength(1);
  });

  test("broken audio metadata leaves the reader usable", async ({ page }) => {
    await page.route("**/api/library/quran-audio", (r) => r.fulfill({ status: 503, body: "{}" }));
    await page.goto("/library/quran/78?lang=en");
    await expect(page.getByTestId("quran-player-meta-error")).toBeVisible();
    await expect(page.getByTestId("ayah")).toHaveCount(40);
  });
});

test.describe("real media against the official CDN", () => {
  test.setTimeout(150_000);

  test("1:1, page 583 and 114:1 load, seek and advance", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop-1440" || !process.env.BALLIGH_REAL_MEDIA, "real media runs once on request");
    const results: Record<string, unknown>[] = [];
    const sample = async (label: string, expected: number) => {
      await expect(player(page)).toHaveAttribute("data-phase", /playing|needsTap|error/, { timeout: 60_000 });
      const phase = await player(page).getAttribute("data-phase");
      const read = () =>
        page.evaluate(() => {
          const a = document.querySelector<HTMLAudioElement>('[data-testid="quran-audio"]')!;
          return { src: a.currentSrc, t: a.currentTime, paused: a.paused, duration: a.duration, readyState: a.readyState };
        });
      const first = await read();
      await page.waitForTimeout(2500);
      const second = await read();
      results.push({ label, expected, phase, first, second, advanced: second.t - first.t });
      expect(phase).toBe("playing");
      expect(first.t).toBeGreaterThanOrEqual(expected - 0.25);
      expect(first.t).toBeLessThan(expected + 2);
      expect(second.t).toBeGreaterThan(first.t + 1);
    };
    try {
      await openSurah(page, 1);
      await page.locator('[data-aya="1"]').getByTestId("ayah-listen").click();
      await sample("1:1", 0.3);
      await page.getByTestId("audio-stop").click();
      await openSurah(page, 78);
      await page.getByTestId("audio-mode-page").check();
      await page.getByTestId("audio-page").selectOption("583");
      await page.getByTestId("audio-play").click();
      await sample("page 583 (78:31)", 147.36);
      await page.getByTestId("audio-stop").click();
      await openSurah(page, 114);
      await page.locator('[data-aya="1"]').getByTestId("ayah-listen").click();
      await sample("114:1", 0.04);
    } finally {
      writeFileSync(`${OUT}/real-media.json`, JSON.stringify({ browser: page.context().browser()?.version(), results }, null, 1) + "\n");
    }
  });
});
