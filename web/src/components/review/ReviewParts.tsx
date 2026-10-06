import { useTranslation } from "react-i18next";
import type { i18n as I18n } from "i18next";
import ar from "@/i18n/features/review.ar.json";
import en from "@/i18n/features/review.en.json";
import ur from "@/i18n/features/review.ur.json";
import zhHans from "@/i18n/features/review.zh-Hans.json";
import idLocale from "@/i18n/features/review.id.json";
import bn from "@/i18n/features/review.bn.json";
import fr from "@/i18n/features/review.fr.json";
import { useSources } from "@/components/lesson";
import { sourcesForDraft } from "@/lib/teacherSource";
import type { LessonDraft } from "@/lib/types";

const bundles: Record<string, Record<string, string>> = { ar, en, ur, "zh-Hans": zhHans, id: idLocale, bn, fr };
let registered = false;

export function registerReviewStrings(i18n: I18n) {
  if (registered) return;
  registered = true;
  for (const [lng, data] of Object.entries(bundles)) {
    if (!i18n.exists("review.jump", { lng, fallbackLng: false })) i18n.addResourceBundle(lng, "translation", { review: data }, true, false);
  }
}

export type OutlineItem = { id: string; num: string; name: string; sub: string };

export function ReviewOutline({
  items,
  selected,
  onSelect,
  compact,
}: {
  items: OutlineItem[];
  selected: string;
  onSelect: (id: string) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <nav className={compact ? "bl-outline rv-outline rv-outline--compact" : "bl-outline rv-outline"} aria-label={t("review.outline")}>
      <h2 className="bl-outline__title">{t("review.outline")}</h2>
      <ul className="bl-outline__list rv-outline__list">
        {items.map((item) => {
          const on = item.id === selected;
          return (
            <li key={item.id}>
              <button
                type="button"
                className={`bl-outline__item${on ? " is-selected" : ""}`}
                aria-current={on ? "true" : undefined}
                aria-controls={`rv-item-${item.id}`}
                data-testid={`outline-${item.id}`}
                onClick={() => onSelect(item.id)}
              >
                <span className="bl-outline__num" aria-hidden="true">{item.num}</span>
                <span className="bl-outline__text">
                  <span className="bl-outline__name">{item.name}</span>
                  {item.sub && (
                    <span className="bl-outline__sub rv-outline__sub" dir="auto">
                      {item.sub}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function EvidenceRelation({
  draft,
  spanIds,
  describedBy,
  onJump,
}: {
  draft: LessonDraft;
  spanIds: string[];
  describedBy?: string;
  onJump: () => void;
}) {
  const { t } = useTranslation();
  const sources = sourcesForDraft(draft, useSources());
  const spans = spanIds.flatMap((id) => draft.spans.filter((s) => s.id === id));
  const missing = spanIds.length === 0 || spans.length < spanIds.length;
  return (
    <div className="bl-relation rv-relation" data-testid="evidence-relation" data-missing={missing}>
      <span className="bl-relation__mark" aria-hidden="true" />
      {spans.length > 0 && (
        <>
          <span className="rv-relation__line">
            {t("review.basedOn")}:{" "}
            {spans.map((sp, i) => (
              <span key={sp.id} data-span-id={sp.id}>
                {i > 0 && " · "}
                <bdi>{sources[sp.source_id]?.title ?? sp.source_id}</bdi>
                {" — "}
                {t("source.chars", { start: sp.start_offset, end: sp.end_offset })}
              </span>
            ))}
          </span>
          <button type="button" className="bl-relation__jump rv-relation__jump" aria-describedby={describedBy} onClick={onJump}>
            {t("review.jump")}
          </button>
        </>
      )}
      {missing && (
        <span className="bl-relation__missing rv-relation__missing" data-testid="evidence-unavailable">
          {t("review.evidenceUnavailable")}
        </span>
      )}
    </div>
  );
}
