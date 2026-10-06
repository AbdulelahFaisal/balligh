import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ar from "./locales/ar.json";
import en from "./locales/en.json";
import ur from "./locales/ur.json";
import zhHans from "./locales/zh-Hans.json";
import id from "./locales/id.json";
import bn from "./locales/bn.json";
import fr from "./locales/fr.json";
import { dirOf, LOCALES } from "@/lib/types";
import learnAr from "./features/learn.ar.json";
import learnEn from "./features/learn.en.json";
import learnUr from "./features/learn.ur.json";
import learnZhHans from "./features/learn.zh-Hans.json";
import learnId from "./features/learn.id.json";
import learnBn from "./features/learn.bn.json";
import learnFr from "./features/learn.fr.json";
import audioAr from "./features/audio.ar.json";
import audioEn from "./features/audio.en.json";
import audioUr from "./features/audio.ur.json";
import audioZhHans from "./features/audio.zh-Hans.json";
import audioId from "./features/audio.id.json";
import audioBn from "./features/audio.bn.json";
import audioFr from "./features/audio.fr.json";
import teachAr from "./features/teach.ar.json";
import teachEn from "./features/teach.en.json";
import teachUr from "./features/teach.ur.json";
import teachZhHans from "./features/teach.zh-Hans.json";
import teachId from "./features/teach.id.json";
import teachBn from "./features/teach.bn.json";
import teachFr from "./features/teach.fr.json";
import assistantAr from "./features/assistant.ar.json";
import assistantEn from "./features/assistant.en.json";
import assistantUr from "./features/assistant.ur.json";
import assistantZhHans from "./features/assistant.zh-Hans.json";
import assistantId from "./features/assistant.id.json";
import assistantBn from "./features/assistant.bn.json";
import assistantFr from "./features/assistant.fr.json";
import learnerAr from "./features/learner.ar.json";
import learnerEn from "./features/learner.en.json";
import learnerUr from "./features/learner.ur.json";
import learnerZhHans from "./features/learner.zh-Hans.json";
import learnerId from "./features/learner.id.json";
import learnerBn from "./features/learner.bn.json";
import learnerFr from "./features/learner.fr.json";
import reviewAr from "./features/review.ar.json";
import reviewEn from "./features/review.en.json";
import reviewUr from "./features/review.ur.json";
import reviewZhHans from "./features/review.zh-Hans.json";
import reviewId from "./features/review.id.json";
import reviewBn from "./features/review.bn.json";
import reviewFr from "./features/review.fr.json";
import stagesAr from "./features/stages.ar.json";
import stagesEn from "./features/stages.en.json";
import stagesUr from "./features/stages.ur.json";
import stagesZhHans from "./features/stages.zh-Hans.json";
import stagesId from "./features/stages.id.json";
import stagesBn from "./features/stages.bn.json";
import stagesFr from "./features/stages.fr.json";
import readers2Ar from "./features/readers2.ar.json";
import readers2En from "./features/readers2.en.json";
import readers2Ur from "./features/readers2.ur.json";
import readers2ZhHans from "./features/readers2.zh-Hans.json";
import readers2Id from "./features/readers2.id.json";
import readers2Bn from "./features/readers2.bn.json";
import readers2Fr from "./features/readers2.fr.json";
import library2Ar from "./features/library2.ar.json";
import library2En from "./features/library2.en.json";
import library2Ur from "./features/library2.ur.json";
import library2ZhHans from "./features/library2.zh-Hans.json";
import library2Id from "./features/library2.id.json";
import library2Bn from "./features/library2.bn.json";
import library2Fr from "./features/library2.fr.json";

const UI_KEY = "balligh.uiLocale";

function initialLocale(): string {
  try {
    const saved = localStorage.getItem(UI_KEY);
    if (saved && (LOCALES as readonly string[]).includes(saved)) return saved;
  } catch {
  }
  return "ar";
}

export function applyDocumentLocale(lng: string) {
  document.documentElement.lang = lng;
  document.documentElement.dir = dirOf(lng);
  try {
    localStorage.setItem(UI_KEY, lng);
  } catch {
  }
}

i18n.use(initReactI18next).init({
  resources: {
    ar: { translation: { ...ar, learn: { ...ar.learn, ...learnAr }, audio: audioAr, teach: teachAr, assistant: assistantAr, learner: learnerAr, stages: stagesAr, readers2: readers2Ar, library2: library2Ar, review: { ...ar.review, ...reviewAr } } },
    en: { translation: { ...en, learn: { ...en.learn, ...learnEn }, audio: audioEn, teach: teachEn, assistant: assistantEn, learner: learnerEn, stages: stagesEn, readers2: readers2En, library2: library2En, review: { ...en.review, ...reviewEn } } },
    ur: { translation: { ...ur, learn: { ...ur.learn, ...learnUr }, audio: audioUr, teach: teachUr, assistant: assistantUr, learner: learnerUr, stages: stagesUr, readers2: readers2Ur, library2: library2Ur, review: { ...ur.review, ...reviewUr } } },
    "zh-Hans": { translation: { ...zhHans, learn: { ...zhHans.learn, ...learnZhHans }, audio: audioZhHans, teach: teachZhHans, assistant: assistantZhHans, learner: learnerZhHans, stages: stagesZhHans, readers2: readers2ZhHans, library2: library2ZhHans, review: { ...zhHans.review, ...reviewZhHans } } },
    id: { translation: { ...id, learn: { ...id.learn, ...learnId }, audio: audioId, teach: teachId, assistant: assistantId, learner: learnerId, stages: stagesId, readers2: readers2Id, library2: library2Id, review: { ...id.review, ...reviewId } } },
    bn: { translation: { ...bn, learn: { ...bn.learn, ...learnBn }, audio: audioBn, teach: teachBn, assistant: assistantBn, learner: learnerBn, stages: stagesBn, readers2: readers2Bn, library2: library2Bn, review: { ...bn.review, ...reviewBn } } },
    fr: { translation: { ...fr, learn: { ...fr.learn, ...learnFr }, audio: audioFr, teach: teachFr, assistant: assistantFr, learner: learnerFr, stages: stagesFr, readers2: readers2Fr, library2: library2Fr, review: { ...fr.review, ...reviewFr } } },
  },
  lng: initialLocale(),
  fallbackLng: "en",
  supportedLngs: [...LOCALES],
  interpolation: { escapeValue: false },
  returnNull: false,
});

applyDocumentLocale(i18n.language);
i18n.on("languageChanged", applyDocumentLocale);

export default i18n;
