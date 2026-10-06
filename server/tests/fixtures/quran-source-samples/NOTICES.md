# QuranEnc source notices (Quran collection)

All times are UTC, taken from the importer cache metadata (`var/library-cache/quran/*/*.meta.json`). Every file in this folder except `manifest.json` and this note holds the exact response bytes; `manifest.json` lists each file's URL, retrieval time, SHA-256 and size, plus the pages read but not stored here because of their size.

## Reproduction terms, quoted

Source: https://quranenc.com/en/home/api/ (QuranEnc.com API page, section "Terms and Policies"), retrieved 2026-10-06T03:40:11+00:00 (page SHA-256 in `manifest.json`).

> Contents of the translations can be downloaded and re-published, with the following terms and conditions:
> 1. No modification, addition, or deletion of the content.
> 2. Clearly referring to the publisher and the source (QuranEnc.com).
> 3. Mentioning the version number when re-publishing the translation.
> 4. Keeping the transcript information inside the document.
> 5. Notifying the source (QuranEnc.com) of any note on the translation.
> 6. Updating the translation according to the latest version issued from the source (QuranEnc.com).
> 7. Inappropriate advertisements must not be included when displaying translations of the meanings of the Noble Quran.

The same seven terms appear in the "Terms and Policies" block of https://quranenc.com/en/browse/bengali_rwwad (retrieved 2026-10-06T03:41:27+00:00).

Note on the same page, quoted:

> It is noteworthy that no matter how accurate any translation of the meanings of the Qur’an may be, it will still fall short in conveying the transcendent meanings of the miraculous Qur’anic text, and that the meanings conveyed by this translation is only the product reached by the extent of the team’s knowledge in understanding this Sacred Book. Hence, this translation cannot be error-free, as is the case with any human endeavor.

Both quotes are stored in `content/library/quran/index.json` → `notices`.

## API routes used

The API page documents `GET https://quranenc.com/api/v1/translations/list/[[{language}]]/?localization={language_iso_code}` and `GET https://quranenc.com/api/v1/translation/sura/{translation_key}/{sura_number}`. The importer uses the sura route for every surah of every edition (cached), not the SQLite downloads.

## Edition versions and where each came from

| Key | Balligh locale | Version | Source of the version |
|---|---|---|---|
| english_rwwad | en | 1.0.19 | `translations-list.json` (https://quranenc.com/api/v1/translations/list, 2026-10-06T03:37:45+00:00) |
| urdu_junagarhi | ur | 1.1.3 | same listing |
| chinese_suliman | zh-Hans | 1.0.8 | same listing (`language_iso_code` "zh") |
| indonesian_affairs | id | 1.0.1 | same listing |
| french_rashid | fr | 1.0.3 | same listing |
| bengali_rwwad | bn | 1.1.2 | catalog card header "27/08/2026 - V1.1.2" |
| arabic_moyassar (tafsir) | ar | 1.0.0 | catalog card header "15/02/2017 - V1.0.0" |

- `bengali_rwwad` and `arabic_moyassar` are not in the default listing (76 entries), and the documented language filter returns no entries for them: `translations-list-bn.json` and `translations-list-ar.json` both hold `{"translations":[]}`.
- Their catalog card headers read the same on https://quranenc.com/en/home (2026-10-06T03:42:11+00:00), https://quranenc.com/ar/home (03:42:59) and https://quranenc.com/ar (03:52:04): Bengali "27/08/2026 - V1.1.2", Muyassar "15/02/2017 - V1.0.0". The edition browse page https://quranenc.com/en/browse/bengali_rwwad (03:41:27) shows no version number.
- Card text on https://quranenc.com/en/home: bengali_rwwad title "Bengali Translation - Rowwad Translation Center", description "Translated by the team of Rowwad Translation Center, in cooperation with the Dawah Association in Rabwah, the Islamic Content Service Association in Languages, and the IslamHouse.com website."; arabic_moyassar title "Arabic Language - At-Tafsir Al-Muyassar", description "Issued by the King Fahd Complex for Printing the Holy Quran in Madinah".
- For the five listed editions, the API version equals the version in the catalog card header on https://quranenc.com/en/home (english_rwwad card "12/03/2026 - V1.0.19").
- `arabic_moyassar` is Al-Tafsir Al-Muyassar, an Arabic tafsir (not a translation), originally published by the King Fahd Quran Printing Complex and delivered here through QuranEnc.

## Other recorded facts

- Locale mapping: `chinese_suliman` is listed as "zh"; Balligh maps it to `zh-Hans` because its 6236 translations contain 22,694 simplified-only and 0 traditional-only characters from a 23-pair check list (for example 们/們, 这/這, 说/說).
- Footnotes: no `null` footnotes in the six editions; `arabic_moyassar` returns `null` footnotes for all 6236 ayahs (the tafsir layer has no footnotes).
- `aya/english_rwwad-001-007.json` is a real multi-footnote ayah response (aya route, three footnotes [6] [7] [8]), retrieved 2026-10-06T03:50:06+00:00; the tests compare it with the stored snapshot.
- Surah names: the snapshot uses standard Arabic surah names embedded by Balligh. The surah list on https://quranenc.com/ar/browse/arabic_moyassar (03:41:27) has the same ayah counts for all 114 surahs and the same names for 108; it spells 14 ابراهيم (Balligh إبراهيم), 34 سبإ (سبأ), 76 الانسان (الإنسان), 78 النبإ (النبأ), 82 الإنفطار (الانفطار), 84 الإنشقاق (الانشقاق).
- The Arabic text (`arabic_text`) is byte-identical across the six editions for all 6236 ayahs (no quarantine), and the tafsir responses carry the same Arabic text.
- No Balligh human, scholarly or language review has been done: every record is `source_preserved` (ingestion checks only).
