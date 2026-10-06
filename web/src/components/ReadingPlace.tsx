import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { recordReading, useReadingState, type ReadingLocation, type SaveOutcome } from "@/lib/reading";

type Confirm = { key: string; outcome: SaveOutcome | "unchanged" } | null;

export function SavePlaceButton({ loc }: { loc: ReadingLocation }) {
  const { t, i18n } = useTranslation();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const key = `${loc.collection}|${loc.id}|${loc.version}|${loc.sha256}|${loc.anchor}|${loc.href}`;
  useEffect(() => {
    if (!confirm) return;
    const h = window.setTimeout(() => setConfirm(null), 6000);
    return () => window.clearTimeout(h);
  }, [confirm]);
  const shown = confirm && confirm.key === key ? confirm.outcome : null;
  const message =
    shown === null
      ? ""
      : shown === "saved" || shown === "unchanged"
        ? t("learn.readingPlace.saved")
        : shown === "invalid"
          ? t("learn.readingPlace.invalid")
          : t("learn.readingPlace.savedSession");
  return (
    <div
      lang={i18n.language}
      dir={i18n.dir(i18n.language)}
      className="mt-3 flex flex-wrap items-center gap-2"
      data-testid="save-place-group"
      data-anchor={loc.anchor}
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="save-place"
        data-anchor={loc.anchor}
        onClick={() => setConfirm({ key, outcome: recordReading(loc) })}
      >
        {t("learn.readingPlace.save")}
      </Button>
      <span role="status" className="text-sm text-muted-foreground" data-testid="save-place-status">
        {message}
      </span>
    </div>
  );
}

export function ReadingStoreNotice() {
  const { t } = useTranslation();
  const { notice } = useReadingState();
  if (!notice) return null;
  return (
    <p role="status" className="surface notice-clay px-3 py-2 text-sm" data-testid="reading-notice" data-notice={notice}>
      {t(`learn.readingStorage.${notice}`)}
    </p>
  );
}

export type RestoreStatus = "idle" | "restored" | "missing";

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function useRestoreAnchor({
  ready,
  recordKey,
  anchor,
}: {
  ready: boolean;
  recordKey: string;
  anchor: string | null;
}): RestoreStatus {
  const [result, setResult] = useState<{ target: string; status: RestoreStatus } | null>(null);
  const live = useRef(recordKey);
  const done = useRef<string | null>(null);
  live.current = recordKey;
  const target = anchor ? `${recordKey}#${anchor}` : null;
  useEffect(() => {
    if (!ready || !anchor || target === null || done.current === recordKey) return;
    const key = recordKey;
    const frame = window.requestAnimationFrame(() => {
      if (live.current !== key || done.current === key) return;
      done.current = key;
      const el = document.getElementById(anchor);
      if (!el) {
        setResult({ target, status: "missing" });
        return;
      }
      if (!el.hasAttribute("tabindex") && el.tabIndex < 0) el.setAttribute("tabindex", "-1");
      el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
      el.focus({ preventScroll: true });
      setResult({ target, status: "restored" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ready, recordKey, anchor, target]);
  if (!ready || target === null || !result || result.target !== target) return "idle";
  return result.status;
}
