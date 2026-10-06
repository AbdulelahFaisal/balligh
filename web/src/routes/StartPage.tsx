import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/lib/workspace";
import { CoverageLine } from "@/routes/LearnPage";

export const FIXTURE_ID = "g1-citation-lesson-en";

export function StartPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const ws = useWorkspace();

  return (
    <section className="mx-auto max-w-3xl space-y-6 py-4" data-testid="home">
      <div className="space-y-3">
        <h1 className="text-3xl font-bold leading-tight">{t("learn.home.title")}</h1>
        <p className="text-lg text-muted-foreground">{t("learn.home.body")}</p>
      </div>
      <div className="surface surface-raised space-y-3 p-5">
        <h2 className="text-xl font-bold">{t("learn.home.learnTitle")}</h2>
        <p>{t("learn.home.learnBody")}</p>
        <Button asChild size="lg">
          <Link to="/learn" data-testid="home-start-learning">
            {t("learn.home.learnCta")}
          </Link>
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="surface space-y-2 p-5">
          <h2 className="text-lg font-bold">{t("learn.home.libraryTitle")}</h2>
          <p className="text-sm">{t("learn.home.libraryBody")}</p>
          <Button asChild variant="outline">
            <Link to="/library" data-testid="home-library">
              {t("learn.home.libraryCta")}
            </Link>
          </Button>
        </div>
        <div className="surface space-y-2 p-5">
          <h2 className="text-lg font-bold">{t("learn.home.prepareTitle")}</h2>
          <p className="text-sm">{t("learn.home.prepareBody")}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => navigate("/setup")} data-testid="home-prepare">
              {t("start.prepare")}
            </Button>
            <Button
              variant="ghost"
              disabled={ws.importState.phase !== "idle"}
              onClick={() => {
                if (ws.draft) navigate("/preview");
                else ws.openExample(FIXTURE_ID, "/preview");
              }}
            >
              {t("start.try")}
            </Button>
          </div>
        </div>
      </div>
      <CoverageLine />
    </section>
  );
}
