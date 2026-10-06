import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspace } from "@/lib/workspace";
import { Button } from "@/components/ui/button";

function ImportConfirm() {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const heading = useRef<HTMLHeadingElement>(null);
  const s = ws.importState;
  const open = s.phase === "confirm" && s.rev === ws.revision;
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open]);
  if (s.phase === "checking")
    return (
      <p className="text-sm font-semibold" data-testid="import-checking" data-kind={s.kind}>
        {t(s.kind === "file" ? "import.checking" : "example.opening")}
      </p>
    );
  if (!open) return null;
  return (
    <section
      aria-labelledby="import-confirm-title"
      className="rounded-lg border-2 border-accent bg-card p-3"
      data-testid="import-confirm"
      data-kind={s.kind}
    >
      <h2 id="import-confirm-title" ref={heading} tabIndex={-1} className="font-semibold">
        {t(s.kind === "file" ? "import.confirmTitle" : "example.confirmTitle")}
      </h2>
      <p className="mt-1">
        {t(s.kind === "file" ? "import.confirmBody" : "example.confirmBody", {
          incoming: `\u2068${s.title}\u2069`,
          current: `\u2068${s.currentTitle}\u2069`,
        })}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="accent" onClick={ws.confirmImport}>
          {t(s.kind === "file" ? "import.confirm" : "example.confirm")}
        </Button>
        <Button variant="outline" onClick={ws.cancelImport}>
          {t("import.keep")}
        </Button>
      </div>
    </section>
  );
}

function StorageNotices() {
  const { t } = useTranslation();
  const { saveFailed, recovery, resetFailed, resetStoredData } = useWorkspace();
  return (
    <>
      {recovery && (
        <div
          role="alert"
          className="rounded-lg border-2 border-accent bg-card p-3"
          data-testid="storage-recovery"
          data-kind={recovery.kind}
        >
          {recovery.kind === "unreadable" ? (
            <>
              <p className="font-semibold">{t("storage.recoveryTitle")}</p>
              <p>{t("storage.recoveryBody", { reason: t(`storage.reason.${recovery.reason}`) })}</p>
              <details className="mt-2">
                <summary className="cursor-pointer">{t("storage.recoveryRaw")}</summary>
                <textarea
                  readOnly
                  dir="ltr"
                  className="mt-2 block h-28 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
                  value={recovery.raw}
                  data-testid="storage-raw"
                />
              </details>
            </>
          ) : (
            <>
              <p className="font-semibold">{t("storage.unavailableTitle")}</p>
              <p>{t("storage.unavailableBody", { reason: t(`storage.reason.${recovery.reason}`) })}</p>
            </>
          )}
          <p className="mt-2 font-semibold" data-testid="storage-paused">
            {t("storage.pausedWarning")}
          </p>
          {resetFailed && (
            <p role="alert" className="mt-2 font-semibold text-accent" data-testid="storage-reset-failed">
              {t("storage.resetFailed")}
            </p>
          )}
          <Button variant="outline" size="sm" className="mt-2" onClick={resetStoredData}>
            {t("storage.reset")}
          </Button>
        </div>
      )}
      {!recovery && saveFailed && (
        <div role="alert" className="rounded-lg border-2 border-accent bg-card p-3" data-testid="storage-save-failed">
          <p>{t("storage.saveFailed")}</p>
        </div>
      )}
    </>
  );
}

export function Notices() {
  const { t } = useTranslation();
  const { error, notice, setError, setNotice } = useWorkspace();
  return (
    <div className="mb-4 space-y-2 empty:hidden" aria-live="polite">
      <StorageNotices />
      <ImportConfirm />
      {error && (
        <div role="alert" className="rounded-lg border-2 border-accent bg-card p-3" data-testid="error-notice">
          <p>{error.status === 0 ? t("error.network") : t("error.generic", { message: error.message })}</p>
          {error.details.length > 0 && (
            <ul className="mt-1 list-disc ps-5 text-sm" dir="ltr" lang="en">
              {error.details.slice(0, 8).map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
          <Button variant="ghost" size="sm" className="mt-1" onClick={() => setError(null)}>
            ×
          </Button>
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-lg border-2 border-primary bg-card p-3">
          <p>{notice}</p>
          <Button variant="ghost" size="sm" className="mt-1" onClick={() => setNotice(null)}>
            ×
          </Button>
        </div>
      )}
    </div>
  );
}
