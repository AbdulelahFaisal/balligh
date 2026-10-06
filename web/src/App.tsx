import type { ReactNode } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { LOCALES, LOCALE_NAMES } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { Notices } from "@/components/Notices";
import { AssistantProvider } from "@/components/assistant/AssistantProvider";
import { AssistantLauncher } from "@/components/assistant/AssistantLauncher";
import { StartPage } from "@/routes/StartPage";
import { SetupPage } from "@/routes/SetupPage";
import { ReviewPage } from "@/routes/ReviewPage";
import { PreviewPage } from "@/routes/PreviewPage";
import { SourcesPage } from "@/routes/SourcesPage";
import { FirstStepBar, LearnPage } from "@/routes/LearnPage";
import { LibraryHome } from "@/routes/library/LibraryHome";
import { QuranList, SurahReader } from "@/routes/library/QuranPages";
import { CollectionList, FatwaReader, HadithReader } from "@/routes/library/CollectionPages";

export const TEACHER_STEPS = [
  { to: "/setup", key: "nav.setup" },
  { to: "/review", key: "nav.review" },
  { to: "/preview", key: "nav.preview" },
] as const;

export const PRIMARY_NAV = [
  { to: "/learn", key: "learn.nav.learn", match: (p: string) => p === "/learn" },
  { to: "/library", key: "learn.nav.library", match: (p: string) => p === "/library" || p.startsWith("/library/") },
  { to: "/setup", key: "learn.nav.prepare", match: (p: string) => TEACHER_STEPS.some((s) => s.to === p) },
] as const;

export const TAGLINE = "بَلِّغُوا عَنِّي وَلَوْ آيَةً";

const NAV_ICONS: Record<string, ReactNode> = {
  "/learn": (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M12 6.5C10 5 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5C17 4.5 14 5 12 6.5Z" />
      <path d="M12 6.5v13" />
    </svg>
  ),
  "/library": (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M4 4h4v16H4zM10 4h4v16h-4z" />
      <path d="m16.5 4.8 3.8-1 3 15.5-3.8 1z" transform="translate(-2 0)" />
    </svg>
  ),
  "/setup": (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
      <path d="m13.5 6.5 4 4" />
    </svg>
  ),
};

export function App() {
  const { t, i18n } = useTranslation();
  const { draft } = useWorkspace();
  const location = useLocation();
  const stageIndex = TEACHER_STEPS.findIndex((s) => s.to === location.pathname);

  return (
    <AssistantProvider>
      <div className="bl-root" dir={i18n.dir(i18n.language)}>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded focus:bg-card focus:px-3 focus:py-2"
        >
          {t("nav.main")}
        </a>
        <div className="bl-frame">
          <header className="bl-frame__rail">
            <NavLink
              to="/"
              end
              aria-label={`${t("app.name")} — ${t("nav.start")}`}
              className="bl-wordmark bl-wordmark--ivory"
              data-testid="brand"
            >
              <span className="bl-wordmark__name" lang="ar">
                بلّغ
              </span>
              <span className="bl-wordmark__tag" lang="ar" dir="rtl" data-testid="brand-tagline">
                {TAGLINE}
              </span>
            </NavLink>
            <nav className="bl-frame__nav" aria-label={t("nav.main")} data-testid="primary-nav">
              {PRIMARY_NAV.map((item) => {
                const active = item.match(location.pathname);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    aria-current={active ? "page" : undefined}
                    className="bl-frame__link"
                    data-testid={`nav-${item.to.slice(1)}`}
                  >
                    <span className="bl-frame__icon" aria-hidden="true">
                      {NAV_ICONS[item.to]}
                    </span>
                    {t(item.key)}
                  </Link>
                );
              })}
              {stageIndex >= 0 && (
                <ol className="bl-rail-steps" aria-label={t("learn.nav.teacherSteps")} data-testid="teacher-steps">
                  {TEACHER_STEPS.map((s, i) => (
                    <li key={s.to} className={cn(i < stageIndex && "is-done", i === stageIndex && "is-current")}>
                      <NavLink to={s.to} aria-current={i === stageIndex ? "step" : undefined} className="bl-rail-step">
                        <span className="bl-rail-step__num" aria-hidden="true">
                          {i + 1}
                        </span>
                        <span>{t(s.key)}</span>
                      </NavLink>
                    </li>
                  ))}
                </ol>
              )}
            </nav>
            <div className="bl-frame__utilities bl-rail-utilities">
              <AssistantLauncher />
              <Link to="/sources" className="text-sm underline-offset-4 hover:underline" data-testid="nav-sources">
                {t("learn.nav.sources")}
              </Link>
              <label className="block">
                <span className="sr-only">{t("lang.label")}</span>
                <select
                  className="bl-rail-select"
                  value={i18n.language}
                  onChange={(e) => void i18n.changeLanguage(e.target.value)}
                  aria-label={t("lang.label")}
                >
                  {LOCALES.map((l) => (
                    <option key={l} value={l} lang={l}>
                      {LOCALE_NAMES[l]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </header>
          <div className="bl-frame__main">
            {stageIndex >= 0 && draft?.is_test_data && (
              <p className="border-b-2 border-accent-soft bg-card px-4 py-2 text-center text-sm" data-testid="testdata-banner">
                {t("testdata")}
              </p>
            )}
            <main id="main" className="bl-main">
              <Notices />
              <Routes>
                <Route path="/" element={<StartPage />} />
                <Route path="/learn" element={<LearnPage />} />
                <Route path="/setup" element={<SetupPage />} />
                <Route path="/review" element={<ReviewPage />} />
                <Route path="/preview" element={<PreviewPage />} />
                <Route path="/sources" element={<SourcesPage />} />
                <Route path="/library" element={<LibraryHome />} />
                <Route path="/library/quran" element={<QuranList />} />
                <Route path="/library/quran/:surah" element={<SurahReader />} />
                <Route path="/library/questions" element={<CollectionList key="questions" kind="questions" />} />
                <Route path="/library/questions/:id" element={<FatwaReader />} />
                <Route path="/library/hadith" element={<CollectionList key="hadith" kind="hadith" />} />
                <Route path="/library/hadith/:id" element={<HadithReader />} />
                <Route path="*" element={<StartPage />} />
              </Routes>
              <FirstStepBar />
            </main>
          </div>
        </div>
      </div>
    </AssistantProvider>
  );
}
