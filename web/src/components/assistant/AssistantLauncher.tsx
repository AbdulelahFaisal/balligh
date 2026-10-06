import { useTranslation } from "react-i18next";
import { useAssistant } from "./AssistantProvider";

export function AssistantLauncher() {
  const { t } = useTranslation();
  const api = useAssistant();
  if (!api) return null;
  return (
    <button
      ref={api.launcherRef}
      type="button"
      className="bl-rail-assist"
      aria-haspopup="dialog"
      aria-expanded={api.open}
      aria-label={t("assistant.launcher")}
      onClick={() => api.setOpen(!api.open)}
      data-testid="assistant-launcher"
    >
      <span aria-hidden="true" className="bl-rail-assist__mark">
        ?
      </span>
      <span>{t("assistant.launcherShort")}</span>
    </button>
  );
}
