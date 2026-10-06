# Balligh (بلّغ)

Balligh turns an Arabic source text into a short lesson in the learner's language that a person can review, and offers a read-only library of the Quran, 100 Ibn Baz fatwas and 150 HadeethEnc hadith.

## What works

- **Teacher journey:** paste one Arabic text (up to 300 words) and choose one of six lesson languages: English, Urdu, Simplified Chinese, Indonesian, Bengali or French. DeepSeek (`deepseek-v4-pro`) drafts three cards, key terms and one question. You compare every card with the source, edit, acknowledge the version, and download it as HTML or JSON. A lesson stays an AI draft until a person acknowledges it.
- **Library:** the complete Quran with six published translations of the meanings and recorded recitation; 100 fatwas; 150 hadith with published translations.
- **Learn:** a five-stage introductory reading path.
- **Assistant:** answers about the site or the source being read, with cited evidence.
- **Interface languages:** Arabic, English, Urdu, Simplified Chinese, Indonesian, Bengali and French.

## Known limits of this submission candidate

- **Fatwa translations:** 85 of 600 fatwa-language pairs have an AI-assisted translation, labelled as such. The other 515 are unavailable; 6 of those are withheld for a known attribution error. The seven Learn-path fatwas are translated in all six languages.
- **Hadith:** 31 of 900 hadith-language pairs have no published translation.
- **Lesson languages:** lessons are produced in six non-Arabic languages. An Arabic-output lesson is not offered.
- **Quran quotations inside translated fatwas:** they stay in Arabic, and a published translation is shown only for a single-ayah reference.
- **Review:** AI-assisted translations and lessons have not been reviewed by native speakers or scholars.

## Run with Docker

Prerequisite: Docker.

    cp .env.example .env
    # edit .env and put your DeepSeek key after DEEPSEEK_API_KEY=
    docker build -t balligh .
    docker run --rm --env-file .env -p 8000:8000 balligh

Open http://127.0.0.1:8000/. The `.env` file sits beside this README. Model, endpoint and paths need no editing.

Without a key, the library, the Learn path, recitation and saved lessons work. Creating a lesson and asking about a fatwa or hadith need the key.

## Run natively

Python 3.13 and Node 24:

    python -m venv .venv
    .venv/bin/pip install -r server/requirements.txt        # Windows: .venv\Scripts\pip
    cd web && npm ci && npm run build && cd ..
    .venv/bin/python -m uvicorn --app-dir server --factory balligh.api:create_app --port 8000

## Tests

    .venv/bin/pip install -r server/requirements-dev.txt
    cd server && ../.venv/bin/python -m pytest -q
    cd ../web && npx tsc -b --noEmit && npx vitest run

Browser specs (Playwright) expect a keyless server: run `python tools/serve_offline.py 8000`, then `cd web && npx playwright test`.

## Configuration

- `DEEPSEEK_API_KEY`: required for generation.
- `BALLIGH_LEDGER_DIR`: `off` disables the local generation ledger.
- `PORT`: defaults to 8000.

## Licences

Project code is MIT (`LICENSE`). Source texts, published translations, fonts and recitation metadata keep their own terms; see `THIRD_PARTY_NOTICES.md` and `content/notices/`. The translations in `content/translations/` were generated with DeepSeek and are labelled AI-assisted in the app.

More: `docs/release/DEPLOY.md`, `docs/release/RELEASE_TREE.md`, `docs/release/TRANSLATION_STATUS.md`.
