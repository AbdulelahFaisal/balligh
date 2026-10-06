import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { useSources } from "@/components/lesson";
import { api, type LocaleReadiness } from "@/lib/api";
import { safeSourceUrl } from "@/lib/safeUrl";

export function SourcesPage() {
  const { t } = useTranslation();
  const sources = Object.values(useSources());
  const [locales, setLocales] = useState<LocaleReadiness[]>([]);
  useEffect(() => {
    api.locales().then(setLocales).catch(() => setLocales([]));
  }, []);
  const yn = (b: boolean) => (b ? t("sourcesPage.yes") : t("sourcesPage.no"));

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-bold">{t("sourcesPage.title")}</h1>
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">{t("sourcesPage.registry")}</h2>
        {sources.map((s) => {
          const href = safeSourceUrl(s.canonical_url);
          return (
            <Card key={s.id}>
              <h3 className="font-semibold"><bdi>{s.title}</bdi></h3>
              <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
                <dt className="font-semibold">{t("sourcesPage.version")}</dt>
                <dd dir="ltr" className="text-start">{s.source_version}</dd>
                <dt className="font-semibold">{t("sourcesPage.rights")}</dt>
                <dd dir="ltr" className="text-start">{s.rights_status}</dd>
                <dt className="font-semibold">{t("source.label")}</dt>
                <dd>
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                      {t("source.open")}
                    </a>
                  ) : (
                    <>
                      {t("source.local")} · <code dir="ltr">{s.local_reference}</code>
                    </>
                  )}
                </dd>
                <dt className="font-semibold">{t("sourcesPage.provenance")}</dt>
                <dd dir="ltr" lang="en" className="text-start">{s.provenance_note}</dd>
              </dl>
              {s.is_test_data && <p className="mt-2 text-sm font-semibold text-accent">{t("source.test")}</p>}
            </Card>
          );
        })}
      </div>

      <div>
        <h2 className="text-lg font-semibold">{t("sourcesPage.localeTitle")}</h2>
        <p className="mb-2 text-sm text-muted-foreground">{t("sourcesPage.localeNote")}</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse rounded-lg bg-card text-sm">
            <thead>
              <tr className="border-b border-border text-start">
                <th className="p-2 text-start" scope="col">—</th>
                <th className="p-2 text-start" scope="col">{t("sourcesPage.ui")}</th>
                <th className="p-2 text-start" scope="col">{t("sourcesPage.generation")}</th>
                <th className="p-2 text-start" scope="col">{t("sourcesPage.content")}</th>
                <th className="p-2 text-start" scope="col">{t("sourcesPage.audio")}</th>
              </tr>
            </thead>
            <tbody>
              {locales.map((l) => (
                <tr key={l.locale} className="border-b border-border">
                  <th scope="row" className="p-2 text-start font-mono">{l.locale}</th>
                  <td className="p-2">{yn(l.ui_ready)}</td>
                  <td className="p-2">{yn(l.generation_tested)}</td>
                  <td className="p-2">{yn(l.content_reviewed)}</td>
                  <td className="p-2">{yn(l.audio_tested)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold">{t("sourcesPage.limitsTitle")}</h2>
        <ul className="mt-2 list-disc space-y-1 ps-5">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <li key={i}>{t(`sourcesPage.limit${i}`)}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
