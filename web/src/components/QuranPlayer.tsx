import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import {
  activeAyah,
  boundaryStep,
  createGuard,
  firstAyahOfPage,
  pageMap,
  pageOfAyah,
  pagesForSurah,
  planFor,
  quranAudioApi,
  surahsNeeded,
  surahsOnPage,
  unavailableReason,
  waitForEvent,
  type AudioSummary,
  type Segment,
  type Selection,
  type SurahTiming,
} from "@/lib/quranAudio";

type Phase = "idle" | "loading" | "playing" | "paused" | "needsTap" | "ended" | "error" | "unavailable";

export interface ActiveAyah {
  surah: number;
  ayah: number;
}

export interface QuranPlayerController {
  playAyah: (ayah: number) => void;
}

interface Props {
  surah: number;
  ayahCount: number;
  names: Record<number, string>;
  onActive?: (active: ActiveAyah | null) => void;
  onSelectAyah?: (surah: number, ayah: number) => void;
  controller?: Ref<QuranPlayerController>;
}

const btn =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-input bg-card px-4 font-semibold hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50";

export default function QuranPlayer({ surah, ayahCount, names, onActive, onSelectAyah, controller }: Props) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const guard = useRef(createGuard()).current;
  const timings = useRef(new Map<number, SurahTiming>());
  const plan = useRef<{ id: number; segments: Segment[]; index: number } | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const [summary, setSummary] = useState<AudioSummary | null>(null);
  const [meta, setMeta] = useState<"loading" | "ready" | "error">("loading");
  const [current, setCurrent] = useState<SurahTiming | null>(null);
  const [mode, setMode] = useState<"ayah" | "page">("ayah");
  const [ayah, setAyah] = useState(1);
  const [page, setPage] = useState<number | null>(null);
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [reason, setReason] = useState<string | null>(null);
  const [now, setNow] = useState<ActiveAyah | null>(null);
  const activeCb = useRef(onActive);
  activeCb.current = onActive;

  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  const pages = useMemo(() => (summary ? pageMap(summary) : new Map<number, [number, number][]>()), [summary]);
  const surahPages = useMemo(() => pagesForSurah(pages, surah), [pages, surah]);

  useEffect(() => {
    const ctl = new AbortController();
    Promise.all([quranAudioApi.summary(ctl.signal), quranAudioApi.surah(surah, ctl.signal)])
      .then(([s, timing]) => {
        timings.current.set(surah, timing);
        setSummary(s);
        setCurrent(timing);
        setMeta("ready");
      })
      .catch(() => {
        if (!ctl.signal.aborted) setMeta("error");
      });
    return () => ctl.abort();
  }, [surah]);

  useEffect(() => {
    if ((page === null || !surahPages.includes(page)) && surahPages.length > 0) setPage(surahPages[0]);
  }, [page, surahPages]);

  useEffect(() => {
    setAyah((n) => (n > ayahCount ? 1 : n));
  }, [ayahCount]);

  const lastReported = useRef<string>("");
  const report = useCallback((value: ActiveAyah | null) => {
    const key = value ? `${value.surah}:${value.ayah}` : "";
    if (key === lastReported.current) return;
    lastReported.current = key;
    setNow(value);
    activeCb.current?.(value);
  }, []);

  const halt = useCallback(() => {
    guard.next();
    plan.current = null;
    audioRef.current?.pause();
  }, [guard]);

  useEffect(() => () => halt(), [halt]);

  const loadTiming = useCallback(async (n: number) => {
    const have = timings.current.get(n);
    if (have) return have;
    const fetched = await quranAudioApi.surah(n);
    timings.current.set(n, fetched);
    return fetched;
  }, []);

  const startSegment = useCallback(
    async (id: number, index: number) => {
      const a = audioRef.current;
      const p = plan.current;
      const signal = guard.signal(id);
      if (!a || !p || p.id !== id || !signal || !guard.claim(id)) return;
      const seg = p.segments[index];
      p.index = index;
      setPhase("loading");
      report({ surah: seg.surah, ayah: seg.fromAyah });
      try {
        if (a.getAttribute("src") !== seg.track) {
          a.pause();
          a.preload = "metadata";
          a.src = seg.track;
          a.load();
        }
        await waitForEvent(a, "loadedmetadata", () => a.readyState >= 1 && a.getAttribute("src") === seg.track, signal);
        if (!guard.isCurrent(id)) return;
        if (Math.abs(a.currentTime - seg.startS) > 0.05) {
          const seeked = waitForEvent(a, "seeked", () => false, signal);
          a.currentTime = seg.startS;
          await seeked;
        }
        if (!guard.isCurrent(id)) return;
        await a.play();
        if (!guard.isCurrent(id)) {
          if (guard.owns(id)) a.pause();
          return;
        }
        setPhase("playing");
      } catch (e) {
        if (!guard.isCurrent(id)) return;
        if ((e as Error)?.name === "NotAllowedError") setPhase("needsTap");
        else setPhase("error");
      }
    },
    [guard, report, setPhase],
  );

  const begin = useCallback(
    async (sel: Selection) => {
      const id = guard.next();
      plan.current = null;
      audioRef.current?.pause();
      setReason(null);
      setPhase("loading");
      report(null);
      try {
        await Promise.all(surahsNeeded(sel, pages).map(loadTiming));
      } catch {
        if (guard.isCurrent(id)) setPhase("error");
        return;
      }
      if (!guard.isCurrent(id)) return;
      const resolved = planFor(sel, pages, timings.current);
      if (!resolved) {
        setPhase("error");
        return;
      }
      if (!resolved.ok) {
        setReason(`${resolved.surah}:${resolved.ayah} — ${resolved.reason}`);
        setPhase("unavailable");
        return;
      }
      plan.current = { id, segments: resolved.segments, index: 0 };
      const first = resolved.segments[0];
      onSelectAyah?.(first.surah, first.fromAyah);
      await startSegment(id, 0);
    },
    [guard, loadTiming, onSelectAyah, pages, report, setPhase, startSegment],
  );

  const tick = useCallback(() => {
    const a = audioRef.current;
    const p = plan.current;
    if (!a || !p || !guard.isCurrent(p.id) || phaseRef.current !== "playing") return;
    const seg = p.segments[p.index];
    const step = boundaryStep(p.segments, p.index, a.currentTime, a.ended);
    if (step === "continue") {
      const timing = timings.current.get(seg.surah);
      const ay = timing ? activeAyah(timing, seg, a.currentTime) : null;
      if (ay !== null) report({ surah: seg.surah, ayah: ay });
      return;
    }
    if (step === "next") {
      void startSegment(p.id, p.index + 1);
      return;
    }
    a.pause();
    plan.current = null;
    guard.next();
    setPhase("ended");
    report(null);
  }, [guard, report, setPhase, startSegment]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onError = () => {
      const p = plan.current;
      if (p && guard.isCurrent(p.id) && (phaseRef.current === "playing" || phaseRef.current === "loading")) setPhase("error");
    };
    a.addEventListener("timeupdate", tick);
    a.addEventListener("ended", tick);
    a.addEventListener("error", onError);
    return () => {
      a.removeEventListener("timeupdate", tick);
      a.removeEventListener("ended", tick);
      a.removeEventListener("error", onError);
    };
  }, [guard, setPhase, tick]);

  useEffect(() => {
    if (phase !== "playing") return;
    const timer = window.setInterval(tick, 100);
    return () => window.clearInterval(timer);
  }, [phase, tick]);

  const selection: Selection | null =
    mode === "ayah" ? { kind: "ayah", surah, ayah } : page !== null ? { kind: "page", page } : null;

  const resetTo = (apply: () => void) => {
    halt();
    apply();
    setReason(null);
    setPhase("idle");
    report(null);
  };

  const play = async () => {
    const a = audioRef.current;
    const p = plan.current;
    if (a && p && guard.isCurrent(p.id) && (phase === "paused" || phase === "needsTap")) {
      try {
        await a.play();
        if (guard.isCurrent(p.id)) setPhase("playing");
        else if (guard.owns(p.id)) a.pause();
      } catch (e) {
        if (guard.isCurrent(p.id)) setPhase((e as Error)?.name === "NotAllowedError" ? "needsTap" : "error");
      }
      return;
    }
    if (selection) await begin(selection);
  };

  useImperativeHandle(
    controller,
    () => ({
      playAyah: (n: number) => {
        setMode("ayah");
        setAyah(n);
        void begin({ kind: "ayah", surah, ayah: n });
      },
    }),
    [begin, surah],
  );

  const ayahReason = (n: number) => (current ? unavailableReason(current, n) : null);
  const selectedReason = mode === "ayah" ? ayahReason(ayah) : null;
  const pageSurahs = page !== null ? surahsOnPage(pages, page) : [];
  const pageFirst = page !== null ? firstAyahOfPage(pages, page) : null;
  const publisher = summary?.sources.publisher_page ?? "https://www.mp3quran.net/ar/yasser/downloads";
  const label = (n: number) => names[n] ?? String(n);
  const busy = phase === "loading";

  return (
    <section
      className="bl-qplayer"
      aria-labelledby="quran-player-title"
      data-testid="quran-player"
      data-phase={phase}
      data-now={now ? `${now.surah}:${now.ayah}` : ""}
    >
      <h2 id="quran-player-title" className="bl-qplayer__title">
        {t("audio.title")}
      </h2>
      <p className="bl-qplayer__meta" data-testid="quran-player-attribution">
        {t("audio.reciterLine")}{" "}
        <bdi lang="ar" className="font-semibold">
          ياسر الدوسري
        </bdi>{" "}
        ({t("audio.reciterName")}) · <bdi lang="ar">حفص عن عاصم</bdi> ({t("audio.rewaya")}) · {t("audio.publisher")}{" "}
        <a href={publisher} target="_blank" rel="noreferrer noopener" className="underline">
          MP3Quran
        </a>
      </p>
      <p className="bl-qplayer__meta bl-qplayer__note">{t("audio.note")}</p>
      {meta === "loading" && <p className="text-sm">{t("audio.metaLoading")}</p>}
      {meta === "error" && (
        <p className="text-sm" role="alert" data-testid="quran-player-meta-error">
          {t("audio.metaError")}{" "}
          <a href={publisher} target="_blank" rel="noreferrer noopener" className="underline">
            {t("audio.openPublisher")}
          </a>
        </p>
      )}
      {meta === "ready" && (
        <>
          <div className="bl-qplayer__row">
          <div className="bl-qplayer__buttons">
            <button
              type="button"
              className={btn}
              onClick={() => void play()}
              disabled={busy || (mode === "ayah" && selectedReason !== null) || !selection}
              data-testid="audio-play"
            >
              {phase === "paused" || phase === "needsTap" ? t("audio.resume") : t("audio.play")}
            </button>
            <button
              type="button"
              className={btn}
              onClick={() => {
                audioRef.current?.pause();
                setPhase("paused");
              }}
              disabled={phase !== "playing"}
              data-testid="audio-pause"
            >
              {t("audio.pause")}
            </button>
            <button
              type="button"
              className={btn}
              onClick={() => resetTo(() => undefined)}
              disabled={phase === "idle" || phase === "ended"}
              data-testid="audio-stop"
            >
              {t("audio.stop")}
            </button>
          </div>
          <fieldset className="bl-qplayer__modes">
            <legend className="bl-qplayer__legend">{t("audio.modeLegend")}</legend>
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name="quran-audio-mode"
                checked={mode === "ayah"}
                onChange={() => resetTo(() => setMode("ayah"))}
                data-testid="audio-mode-ayah"
              />
              <span>{t("audio.modeAyah")}</span>
            </label>
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name="quran-audio-mode"
                checked={mode === "page"}
                onChange={() => resetTo(() => setMode("page"))}
                data-testid="audio-mode-page"
              />
              <span>{t("audio.modePage")}</span>
            </label>
          </fieldset>
          {mode === "ayah" ? (
            <label className="flex flex-wrap items-center gap-2">
              <span>{t("audio.ayahLabel")}</span>
              <select
                className="min-h-11 min-w-0 max-w-full rounded-md border border-input bg-background px-2"
                value={ayah}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  resetTo(() => setAyah(n));
                }}
                data-testid="audio-ayah"
              >
                {Array.from({ length: ayahCount }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n} disabled={ayahReason(n) !== null}>
                    {t("audio.ayahOption", { number: n, page: pageOfAyah(pages, surah, n) ?? "—" })}
                    {ayahReason(n) ? ` — ${t("audio.noTiming")}` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="flex flex-wrap items-center gap-2">
              <span>{t("audio.pageLabel")}</span>
              <select
                className="min-h-11 min-w-0 max-w-full rounded-md border border-input bg-background px-2"
                value={page ?? ""}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  resetTo(() => setPage(n));
                }}
                data-testid="audio-page"
              >
                {surahPages.map((p) => {
                  const f = firstAyahOfPage(pages, p);
                  return (
                    <option key={p} value={p}>
                      {t("audio.pageOption", { page: p, first: f ? `${f[0]}:${f[1]}` : "—" })}
                    </option>
                  );
                })}
              </select>
            </label>
          )}
          </div>
          <p className="bl-qplayer__meta" data-testid="audio-boundary">
            {mode === "ayah"
              ? t("audio.boundarySurah", { name: label(surah) })
              : t("audio.boundaryPage", {
                  page: page ?? "—",
                  first: pageFirst ? `${pageFirst[0]}:${pageFirst[1]}` : "—",
                })}
            {mode === "page" && pageSurahs.length > 1 && (
              <> {t("audio.crossSurah", { names: pageSurahs.map(label).join("، ") })}</>
            )}
          </p>
          {selectedReason && (
            <p className="text-sm" data-testid="audio-disabled-reason">
              {t("audio.unavailable")} <bdi dir="ltr">{selectedReason}</bdi>
            </p>
          )}
        </>
      )}
      <p role="status" aria-live="polite" className="bl-qplayer__status" data-testid="audio-status">
        {phase === "idle" && meta === "ready" && t("audio.idle")}
        {phase === "loading" && t("audio.loading")}
        {phase === "playing" && now && t("audio.playing", { name: label(now.surah), surah: now.surah, ayah: now.ayah })}
        {phase === "paused" && t("audio.paused")}
        {phase === "ended" && t("audio.ended")}
        {phase === "needsTap" && t("audio.needsTap")}
        {phase === "unavailable" && (
          <>
            {t("audio.unavailable")} <bdi dir="ltr">{reason}</bdi>
          </>
        )}
        {phase === "error" && (
          <>
            {t("audio.error")}{" "}
            <a href={publisher} target="_blank" rel="noreferrer noopener" className="underline">
              {t("audio.openPublisher")}
            </a>
          </>
        )}
      </p>
      <audio ref={audioRef} preload="none" data-testid="quran-audio" />
    </section>
  );
}
