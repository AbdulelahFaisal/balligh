import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { isLive } from "@/lib/provenance";
import type { LessonDraft } from "@/lib/types";

const isolate = (text: string) => `\u2068${text}\u2069`;

export function OriginPanel({ draft }: { draft: LessonDraft }) {
  const { t } = useTranslation();
  const g = draft.generation;
  const live = isLive(g) ? g : null;
  const count = (v: number | null | undefined) => (typeof v === "number" ? v.toLocaleString() : t("origin.unknown"));
  return (
    <Card data-testid="origin-panel" data-origin={g.origin}>
      <h2 className="text-lg font-semibold">{t("origin.title")}</h2>
      <p className="mt-1">
        {live
          ? t("origin.live", { provider: isolate("DeepSeek"), model: isolate(live.requested_model) })
          : t(`origin.${g.origin}`)}
      </p>
      <p className="text-sm text-muted-foreground" data-testid="origin-edited" data-edited={g.human_edited === true}>
        {t(g.human_edited ? "origin.edited" : "origin.notEdited")}
      </p>
      {draft.validation_findings.length > 0 && (
        <div className="mt-2 text-sm">
          <p className="font-semibold">{t("origin.findings")}</p>
          <p className="text-muted-foreground">{t("origin.findingsHelp")}</p>
          <ul className="list-disc ps-5">
            {draft.validation_findings.map((f, i) => (
              <li key={i} dir="auto">
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}
      {live && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer rounded">{t("origin.details")}</summary>
          <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">{t("origin.requestedModel")}</dt>
            <dd>
              <bdi>{live.requested_model}</bdi>
            </dd>
            <dt className="text-muted-foreground">{t("origin.returnedModel")}</dt>
            <dd>
              <bdi>{live.returned_model ?? t("origin.unknown")}</bdi>
            </dd>
            <dt className="text-muted-foreground">{t("origin.prompt")}</dt>
            <dd>
              <bdi>{live.prompt_version}</bdi>
            </dd>
            <dt className="text-muted-foreground">{t("origin.generatedAt")}</dt>
            <dd>
              <bdi>{new Date(live.generated_at).toLocaleString()}</bdi>
            </dd>
            <dt className="text-muted-foreground">{t("origin.request")}</dt>
            <dd className="break-all">
              <bdi>{live.request_id}</bdi>
            </dd>
            <dt className="text-muted-foreground">{t("origin.usage")}</dt>
            <dd>
              <bdi>
                {count(live.usage?.prompt_tokens)} / {count(live.usage?.completion_tokens)} /{" "}
                {count(live.usage?.reasoning_tokens)}
              </bdi>
            </dd>
          </dl>
        </details>
      )}
    </Card>
  );
}
