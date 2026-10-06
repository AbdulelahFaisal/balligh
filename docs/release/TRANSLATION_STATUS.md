# Translation status (submission candidate)

- **Quran:** complete, with six published translations of the meanings (en, ur, zh-Hans, id, bn, fr).
- **Hadith:** 150 records with published HadeethEnc translations; 31 of 900 record-language pairs have no published translation.
- **Fatwas:** 100 Arabic records. All 600 record-language pairs have an AI-assisted translation in `content/translations/fatwa/<locale>/`. The Arabic record stays the published original and is one tap away in the reader. The seven Learn-path fatwas are translated in all six languages.
- **Quran quotations inside translated fatwas:** kept as the original Arabic and never machine-translated. A published translation is shown only for a complete single-ayah reference; ranges show the Arabic only.
- **Publisher symbols:** the four verified Ibn Baz honorific symbols are spelled out in the translation input only; the stored publisher records are byte-identical to the previous release.
- **Checks:** every served file passes the same strict validator at creation, resume and serving (record hash, language, prompt version, unit ids and order, tokens exactly once). Verified at 2026-10-07T00:33:40+03:00: 600 served, 0 invalid files, 0 attribution flags.
- **Editorial correction:** one recorded precision correction was made by hand after generation, in `en/binbaz-1157`, unit `a0`: “if he is a virgin” became “if he is a bikr (someone who has not previously consummated a valid marriage)”, to state the legal category in «إذا كان بكرا». Every other passage in the 600 files is as generated.
- **Review:** the AI-assisted translations as a whole have not been reviewed by native speakers or scholars.

To resume the batch (billed, resumable, at most 2 requests in flight, absent or invalid pairs only):

    python server/tools/translate_fatwas.py --stop-at 2026-10-07T00:45:00+03:00 --max-attempts 650 --concurrency 2

`--stop-at` takes an ISO 8601 timestamp with an explicit offset; a past or naive value is refused before any request.
