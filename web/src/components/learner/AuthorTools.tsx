import { useTranslation } from "react-i18next";
import { ImportButton } from "@/components/lesson";
import { useWorkspace } from "@/lib/workspace";

export function AuthorTools() {
  const { t } = useTranslation();
  const ws = useWorkspace();
  return (
    <details className="bl-lx__author" data-testid="author-toolbar">
      <summary className="bl-lx__author-summary">
        <span id="author-tools-title">{t("author.title")}</span>
      </summary>
      <div className="bl-lx__author-body" role="group" aria-labelledby="author-tools-title">
        <p className="bl-lx__muted">{t("author.help")}</p>
        <div className="bl-lx__row">
          <button
            type="button"
            className="bl-btn bl-btn--tool"
            disabled={ws.exporting.html}
            aria-busy={ws.exporting.html}
            onClick={() => void ws.exportLesson("html")}
          >
            {ws.exporting.html ? t("export.preparing", { kind: "HTML" }) : t("preview.exportHtml")}
          </button>
          <button
            type="button"
            className="bl-btn bl-btn--tool"
            disabled={ws.exporting.json}
            aria-busy={ws.exporting.json}
            onClick={() => void ws.exportLesson("json")}
          >
            {ws.exporting.json ? t("export.preparing", { kind: "JSON" }) : t("preview.exportJson")}
          </button>
          <ImportButton />
          <button type="button" className="bl-btn bl-btn--quiet" onClick={ws.clear}>
            {t("storage.clear")}
          </button>
        </div>
      </div>
    </details>
  );
}
