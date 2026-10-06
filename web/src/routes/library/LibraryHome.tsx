import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { libraryApi, useGuardedResource, type QuranRange } from "@/lib/library";

export function RangeLabel({ range }: { range: QuranRange }) {
  const { t } = useTranslation();
  return (
    <>
      {range.kind === "full"
        ? t("library.quran.rangeFull", { surahs: range.surah_count, ayahs: range.ayah_count })
        : t("library.quran.rangeJuzAmma", {
            first: range.surah_first,
            last: range.surah_last,
            surahs: range.surah_count,
            ayahs: range.ayah_count,
          })}
    </>
  );
}

/* Small decorative glyphs that give each collection its own identity. */
function CollectionIcon({ kind }: { kind: "quran" | "questions" | "hadith" }) {
  const common = {
    width: 26,
    height: 26,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
  };
  if (kind === "quran") {
    return (
      <svg {...common}>
        <path d="M12 6.5c-2-1.6-4.6-2-7.5-1.5v13c2.9-.5 5.5-.1 7.5 1.5 2-1.6 4.6-2 7.5-1.5V5c-2.9-.5-5.5-.1-7.5 1.5Z" />
        <path d="M12 6.5v13" />
      </svg>
    );
  }
  if (kind === "questions") {
    return (
      <svg {...common}>
        <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-7l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5Z" />
        <path d="M10.2 9.6a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.3" />
        <path d="M12 14.6h.01" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M7 4.5h9.5A1.5 1.5 0 0 1 18 6v12.5a1.5 1.5 0 0 1-1.5 1.5H7" />
      <path d="M7 4.5A2 2 0 0 0 5 6.5v11A2.5 2.5 0 0 0 7.5 20" />
      <path d="M9 9h6M9 12h6M9 15h4" />
    </svg>
  );
}

export function LibraryHome() {
  const { t } = useTranslation();
  const { state } = useGuardedResource("library-index", (signal) => libraryApi.index(signal));
  const c = state?.status === "ready" ? state.data.collections : null;
  // Reading languages besides Arabic that the catalog actually covers for fatwas (stored translations per language).
  // The AI-assisted provenance of those translations is stated in the reader, beside the text itself.
  const stored = (c?.fatwa as { machine_translations?: Record<string, number> } | undefined)?.machine_translations;
  const extraLanguages = stored ? Object.values(stored).filter((n) => n > 0).length : 0;
  const range = c?.quran?.range;
  const cards: { to: string; key: "quran" | "questions" | "hadith"; count: ReactNode; arabicOnly?: boolean }[] = [
    {
      to: "/library/quran",
      key: "quran",
      count: range ? <RangeLabel range={range} /> : null,
    },
    {
      to: "/library/questions",
      key: "questions",
      count: typeof c?.fatwa?.count === "number" ? t("library.questions.count", { count: c.fatwa.count }) : null,
      arabicOnly: true,
    },
    {
      to: "/library/hadith",
      key: "hadith",
      count: typeof c?.hadith?.count === "number" ? t("library.hadith.count", { count: c.hadith.count }) : null,
    },
  ];

  return (
    <section className="mx-auto max-w-4xl space-y-7" data-testid="library-home">
      <div>
        <h1 className="text-3xl font-bold leading-tight">{t("library.title")}</h1>
        <p className="mt-3 max-w-2xl text-lg text-muted-foreground">{t("library.intro")}</p>
      </div>
      <ul className="lib-home-grid">
        {cards.map((card) => (
          <li key={card.key} className="min-w-0">
            <Link
              to={card.to}
              className={`list-card lib-dest lib-dest-${card.key} text-foreground no-underline`}
              data-testid={`collection-${card.key}`}
            >
              <span className="lib-dest-icon">
                <CollectionIcon kind={card.key} />
              </span>
              <span className="lib-dest-title">{t(`library.${card.key}.title`)}</span>
              <span className="lib-dest-desc">{t(`library2.home.${card.key}Desc`)}</span>
              <span className="lib-dest-meta">
                {card.count ? (
                  <span className="lib-dest-count" data-testid={`collection-${card.key}-count`}>
                    {card.count}
                  </span>
                ) : (
                  <span className="lib-dest-count" aria-hidden="true">
                    &nbsp;
                  </span>
                )}
                {card.arabicOnly && (
                  <span className="badge-clay lib-dest-badge" data-testid={`collection-${card.key}-languages`}>
                    {extraLanguages > 0 ? t("library2.home.arabicPlus", { n: extraLanguages }) : t("library2.home.arabicOnly")}
                  </span>
                )}
              </span>
              <span className="lib-dest-open" aria-hidden="true">
                {t("library2.home.open")}
                <span className="lib-dest-arrow">→</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">{t("library.notice")}</p>
    </section>
  );
}
