# G4-A-P1 source notices, use limits and corrections

This file updates `docs/review/G4-A/SOURCE_NOTICES.md`, which is kept unchanged as archived evidence. The publisher terms quoted there still apply. This file records what G4-A-P1 changed, and narrows the G4-A wording where its evidence was smaller than the claims.

## Corrections to G4-A wording

- G4-A's report said "Everything else required by A is delivered and validated". That was too broad. The coordinator's review found:
  - gaps in snapshot publication safety (N01, N02, N03);
  - a banner that labelled publisher content as test data (N04);
  - narration-variant checking (N05);
  - source fidelity: fatwa footnote identity (N06), HadeethEnc word notes (N07), Quran translator/reviewer credits (N08) and the honorific glyphs (N09);
  - beginner curation (N10).

  G4-A-P1 repairs these as described in `REPORT.md`. Where a repair is incomplete, `REPORT.md` says so.
- G4-A's notices said the exact response bytes behind every quote are in `source-samples/`. Only these are retained:
  - the sample responses listed in each `manifest.json`/`responses.json`;
  - the HadeethEnc terms dialog fragments;
  - the Ibn Baz pages listed in `source-samples/fatwa/raw/`.

  The QuranEnc API and catalog pages that supplied the terms quotes and the Bengali/Muyassar versions are recorded by URL, retrieval time and SHA-256 in `source-samples/quran/manifest.json`, but their full bytes are not packaged. The full download cache (`var/library-cache`) is never packaged.
- No library item has had a human scholarly or language review. Each of these is a separate kind of evidence, and none is a review:
  - publisher material;
  - ingestion and validation checks;
  - spot-checks against retained responses;
  - a local teacher acknowledgment of a lesson.

  (U54.)

## Ibn Baz (binbaz.org.sa)

- Footnotes now keep their identity. Each note keeps its number as published and its source order, inline markers link to their note, and notes are never merged or invented. `source-samples/fatwa/notes-verification.json` lists every footnoted record with its raw page hash, note ids and markers.
- Honorific glyphs: four private-use characters are displayed as text by a display-only mapping. The stored text and its hashes are unchanged, and the publisher font is not bundled. The evidence is in `HONORIFIC_EVIDENCE.md`.
- Curation for the beginner audience is recorded in `FATWA_CURATION.md`, with its completion status in `REPORT.md`.
- Reuse basis is unchanged: the user reports email permission from the site (user-confirmed; not inspected; not public domain), and attribution is kept. The site notice «جميع الحقوق محفوظة والنقل متاح لكل مسلم بشرط ذكر المصدر» remains quoted in the G4-A notices.

## HadeethEnc

- The Arabic word notes (`words_meanings`) are now kept as published, as Arabic publisher notes. They are separate from the explanation and hints. Foreign responses repeat them as Arabic copies, which are not presented as localized notes.
- A translation is admitted only when its embedded Arabic wording (`hadeeth_ar`) equals the selected Arabic narration exactly (`arabic_match: "exact"`). If the response carries no Arabic wording, it is marked `not_provided`, never "exact". Mismatches are rejected.
- Version: No version number appears in the API responses or in the cached `/ar/home`, `/en/home` and `/en/home/about` pages. One official request to `https://hadeethenc.com/browse/download/en` redirected to the English download file `HadeethEnc.com_en-v1.25.0.xlsx`. Its cell A1 reads "Last update: 2026-05-10 17:43:35 (v1.25.0)". For the 146 stored English translations, title, hadeeth and hadeeth_ar equal that file. The explanations differ only in line endings, and the file writes the grade in brackets. So v1.25.0 is an explicit version of the English download file only. It is not claimed as the version of the API content, and the other languages' files were not requested. Open publication item: ask HadeethEnc whether `/api/v1` content corresponds to the versioned per-language files, and which identifier a re-publisher should cite under terms 3 and 4 (the per-language file version, its update time, or something else). The retrieval date and content hash are not a verified substitute. Evidence: `source-samples/hadith/evidence.json`.
- Grades remain HadeethEnc's published grades.
- B-A01 remains open. Dorar was not contacted again; it blocked the importer in G4-A. No Dorar verification, and no coordinator waiver of that requirement, is claimed.

## QuranEnc

- The reader now shows each edition's own credit statement verbatim, next to its title and version. For example, the Chinese edition says "Translated by Muhammad Makeen. Reviewed by Muhammad Sulaiman and other language experts", and the Indonesian edition names the Ministry of Religious Affairs and its development under Rowwad Translation Center supervision.
- QuranEnc.com is shown separately as the electronic provider. Al-Tafsir Al-Muyassar names the King Fahd Quran Printing Complex as original publisher, delivered through QuranEnc.com; it is not presented as a government API.
- Scripture, meanings and footnotes are unchanged. No new Quran download was made in G4-A-P1.
