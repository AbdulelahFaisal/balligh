# G4-A source notices and reuse basis

The library under `content/library/` is third-party religious content, stored unchanged for reading. It is not covered by the project's code license (none chosen yet). Each publisher's own terms apply, and one publisher's permission never stands in for another's terms. The detailed notes and the exact response bytes behind every quote are in `source-samples/{quran,fatwa,hadith}/` (`NOTICES.md`, `manifest.json`/`responses.json`, `selection-log.json`). Times are UTC as recorded by the importer cache; Riyadh is UTC+3.

No Balligh human, scholarly or language review has been done. Every record is `review_status: "source_preserved"`, meaning the ingestion checks passed. A publisher's reputation, these checks and a teacher's acknowledgment of a lesson are separate kinds of evidence, and none of them is presented as a review.

## QuranEnc.com — Quran text, translations of the meanings, Al-Muyassar

- **Delivered:** the complete Quran (114 surahs, 6236 ayahs). It has the Arabic text (`arabic_text`, byte-identical across all six editions for every ayah) and six translations of the meanings, with their footnotes kept per ayah and per edition. The Arabic Al-Tafsir Al-Muyassar is a separate, optional layer: it is a tafsir, not a translation. Its original publisher is the King Fahd Quran Printing Complex, and it is delivered here through QuranEnc, not through a direct government API.
- **Routes:**
  - Metadata: `https://quranenc.com/api/v1/translations/list` (76 entries, retrieved 03:37:45).
  - Text: the documented route `https://quranenc.com/api/v1/translation/sura/{key}/{surah}`, cached, 7 keys × 114 surahs.
  - The SQLite downloads were not used.

| Locale | Key | Title (from the publisher) | Version | Version source |
|---|---|---|---|---|
| en | english_rwwad | English Translation - Rowwad Translation Center | 1.0.19 | API listing |
| ur | urdu_junagarhi | Urdu Translation - Muhammad Junagarhi | 1.1.3 | API listing |
| zh-Hans | chinese_suliman | Chinese Translation - Muhammad Suleiman ("Translated by Muhammad Makeen. Reviewed by Muhammad Sulaiman and other language experts") | 1.0.8 | API listing (`zh`; checked as Simplified) |
| id | indonesian_affairs | Indonesian Translation - Ministry of Religious Affairs | 1.0.1 | API listing |
| bn | bengali_rwwad | Bengali Translation - Rowwad Translation Center | 1.1.2 | catalog card header "27/08/2026 - V1.1.2" on /en/home, /ar/home and /ar (not in the API listing) |
| fr | french_rashid | French Translation - Rachid Maach | 1.0.3 | API listing |
| ar (tafsir) | arabic_moyassar | Arabic Language - At-Tafsir Al-Muyassar | 1.0.0 | catalog card header "15/02/2017 - V1.0.0" (not in the API listing) |

These are the versions observed at ingestion, not a permanent "latest" claim.

**Terms**, quoted from `https://quranenc.com/en/home/api/` ("Terms and Policies", retrieved 03:40:11; the same terms appear on the edition browse page):

> Contents of the translations can be downloaded and re-published, with the following terms and conditions: 1. No modification, addition, or deletion of the content. 2. Clearly referring to the publisher and the source (QuranEnc.com). 3. Mentioning the version number when re-publishing the translation. 4. Keeping the transcript information inside the document. 5. Notifying the source (QuranEnc.com) of any note on the translation. 6. Updating the translation according to the latest version issued from the source (QuranEnc.com). 7. Inappropriate advertisements must not be included when displaying translations of the meanings of the Noble Quran.

**How Balligh applies them:**

- Text and footnotes are stored exactly as returned.
- The reader names the edition, its version and QuranEnc.com, with a link, wherever a translation is shown.
- No advertisements are shown.
- Updating is a re-run of `import_quran.py`.
- Notes about a translation go to QuranEnc (a team process).
- The publisher's note that any translation of the meanings falls short of the original is quoted in the index notices.
- Surah names are standard Arabic names embedded by Balligh. QuranEnc's list agrees on all 114 ayah counts and on 108 names; the six spelling differences are recorded in the index.

## HadeethEnc.com — authentic hadith, published translations and explanations

- **Delivered:** 150 narrations whose published Arabic `grade` is exactly «صحيح», with HadeethEnc's attribution, explanation and hints kept in their own fields.
  - Per-locale published translations: en 146, ur 146, zh-Hans 144, id 146, bn 146, fr 141.
  - 139 narrations have all seven languages.
  - A translation the publisher does not have, or one missing a required field, is not stored, and nothing was generated.
- **Routes:** the documented API `https://hadeethenc.com/api/v1/` (categories, list, one).
  - `https://github.com/islamhouse-dev/hadith-api` ("HadeethEnc.com official API") documents the same routes and offers no bulk export.
  - `https://hadeethenc.com/api-docs/` redirects to a JavaScript Postman page with no separate licence.

**Terms**, quoted from the "Terms and Policies" dialog on `https://hadeethenc.com/en/home` (retrieved 03:38:35; the Arabic dialog on `/ar/home` matches):

> Contents of the translations can be downloaded and re-published, with the following terms and conditions: 1. No modification, addition, or deletion of the content. 2. Clearly referring to the publisher and the source (HadeethEnc.com). 3. Mentioning the version number when re-publishing the translation. 4. Keeping the transcript information inside the document. 5. Notifying the source (HadeethEnc.com) of any note on the translation. 6. Updating the translation according to the latest version issued from the source (HadeethEnc.com). 7. Inappropriate advertisements must not be included when displaying the content of the Prophet’s Hadiths and their translations.

**How Balligh applies them:**

- Fields are stored exactly as returned; even trailing `\r` in hints is kept.
- Every record and translation links its own HadeethEnc page.
- **Open item (version):** the API returns no version number, so the reader shows the retrieval date instead. Ask HadeethEnc which version identifier to cite.
- The grade is shown as HadeethEnc's published grade (`grading_authority: "HadeethEnc.com (grade field of the published record)"`); Balligh does not grade hadith.
- HadeethEnc has no separate narrator field. The narrator is part of the hadith text, so `narrator` is `null`.

## binbaz.org.sa — Questions about Islam (Ibn Baz fatwas)

- **Delivered:** 100 unique complete fatwas, each with the full original question and answer, Quran and hadith quotations and references. There are 25 per Balligh topic: understanding Islam, belief, worship, everyday conduct. The selection log records the start pages (category 206, pages 1–2), the categories followed and the single exclusion.
- **Translations:** no fatwa page links an official translation of the same fatwa. The collection is Arabic only, and no machine translation is shown.
- **Site notice,** quoted from the footer of every fetched page:

  > جميع الحقوق محفوظة والنقل متاح لكل مسلم بشرط ذكر المصدر

  (A literal rendering for reviewers: "All rights reserved; copying is permitted for every Muslim on condition that the source is cited.")
- **Reuse basis:** `user_confirmed_permission`. The user reports email permission from Ibn Baz for this project. That email was not inspected by the implementer, and the permission is not a public-domain status. Each record keeps the official page link and the publisher name, and the reader shows both.

## dorar.net — selected for hadith grading; not reachable

- The user reports email permission from Dorar as well (user-confirmed, not inspected).
- Every route tried returned HTTP 403 with a Cloudflare page ("Attention Required! | Cloudflare", "Sorry, you have been blocked") to the honestly identified importer:
  - The probes at 06:24–06:25 Riyadh hit the home page, `/h/MXnb6eUb`, `/article/389` and the documented `dorar_api.json`.
  - The importer's single evidence request at 04:00:02 UTC was recorded with its Cloudflare ray ID in `source-samples/hadith/dorar-block.json`.
- No bypass was attempted: no browser impersonation, headless browser, mirror or unofficial wrapper.
- No Dorar wording, reference or grade is used, and every hadith record stores `dorar.status: "not_verified"` with that reason.
