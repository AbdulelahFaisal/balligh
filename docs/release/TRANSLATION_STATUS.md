# Translation status (submission candidate)

- **Quran:** complete, with six published translations of the meanings (en, ur, zh-Hans, id, bn, fr).
- **Hadith:** 150 records with published HadeethEnc translations; 31 of 900 record-language pairs have no published translation.
- **Fatwas:** 100 Arabic records. 85 of 600 record-language pairs have an AI-assisted translation in `content/translations/fatwa/<locale>/`. 515 are unavailable, including 6 withheld for a known attribution error (binbaz-1158). The seven Learn-path fatwas are translated in all six languages.
- **Quran quotations inside translated fatwas:** kept as the original Arabic and never machine-translated. A published translation is shown only for a complete single-ayah reference; ranges show the Arabic only.
- **Review:** new AI-assisted translations have not been reviewed by native speakers or scholars.

To continue the batch (billed, resumable, at most 2 requests in flight):

    python server/tools/translate_fatwas.py --stop HH:MM --concurrency 2
