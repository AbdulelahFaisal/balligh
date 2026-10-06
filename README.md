# Balligh

From source to lesson, in the learner's language.

[Try Balligh](https://balligh.onrender.com) · [Source code](https://github.com/AbdulelahFaisal/balligh)

Balligh helps teachers and people introducing Islam turn their Arabic teaching text into a multilingual lesson. The teacher keeps control of the material: paste a text, choose the learner's language, compare the lesson with the Arabic original, edit it, and export it for sharing.

## The teacher's workflow

1. Paste Arabic text and choose a language and lesson level. A selected library source is also available as an optional starting point.
2. Create a lesson with reading cards, Arabic terms and their meanings, and a comprehension question.
3. Compare each card and question with its supporting passage in the original. Edit the lesson in place.
4. Record that the current version was compared with the source, then export HTML or JSON. JSON exports can be imported again.

Changing a lesson clears its previous comparison acknowledgment. Source quotations stay tied to the original text. The acknowledgment records the teacher's comparison of that version.

## The learner's experience

Learners read a card, open the meaning of a term, and check their understanding. A wrong answer leads back to the supporting passage and a retry. Progress and saved reading places help the learner continue later.

The Learn destination arranges introductory reading into five stages. The Library brings Quran, fatwas and hadith together with search, reading-language selection, source links and reading-place controls.

## Languages

The interface supports Arabic, English, Urdu, Simplified Chinese, Indonesian, Bengali and French.

Teachers can create lessons in English, Urdu, Simplified Chinese, Indonesian, Bengali and French, with the Arabic original available for comparison. Arabic terms remain visible with a meaning in the learner's language.

## The content library

| Collection | Included content |
| --- | --- |
| Quran | All 114 surahs and 6,236 ayahs, with six published translations of the meanings, footnotes, edition credits and optional separately labelled Al-Tafsir Al-Muyassar. |
| Fatwas | 100 complete Arabic fatwas from the official Ibn Baz website, with 600 stored AI-assisted translations: all 100 fatwas in English, Urdu, Simplified Chinese, Indonesian, Bengali and French. |
| Hadith | 150 narrations with the grade “sahih” as published by HadeethEnc, together with the publisher's explanations and available translations. |

The reader shows the translation available for each record. Published translations are kept distinct from AI-assisted translations and explanations. Quran meanings are retrieved from the stored published editions.

Fatwa translations are stored with the source and are available to read without making a new model request. The Arabic original, footnotes and source links remain available alongside them.

Quran recitation uses Yasser Al-Dosari recordings and timing information from MP3Quran. The player keeps the selected text and translation together. The assistant offers site guidance and help with the open source; Quran extracts come directly from the library.

The team's religious specialist provided oversight of source selection, terminology and faithful presentation. Publisher names, source links, edition details and reuse terms remain attached to their content.

## Run with Docker

Run these commands from the repository root. Docker must be installed and running.

Copy `.env.example` to `.env` beside this README. To enable lesson generation and model-assisted source explanations, fill in only:

```dotenv
DEEPSEEK_API_KEY=your_key_here
```

```bash
docker build -t balligh .
docker run --rm --env-file .env -p 8000:8000 balligh
```

Open http://127.0.0.1:8000. Library reading, the Learn path, stored Quran meanings and saved-lesson review work independently of a model request.

Keep `.env` private. The key is read by the server and is never included in the public repository or lesson exports. The Docker image uses one server process and disables the local provider ledger by default.

## Run from source

Requirements: Python 3.13 and Node.js 24. These PowerShell commands start in the repository root:

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r server\requirements-dev.txt
npm --prefix web ci
npm --prefix web run build
.venv\Scripts\python -m uvicorn --app-dir server --factory balligh.api:create_app --host 127.0.0.1 --port 8000
```

On Linux or macOS, use `.venv/bin/python` and forward slashes. The local `.env` belongs beside this README. Restart the server after changing environment settings.

## Render

Connect this repository as a Docker web service on `main`. Leave Root Directory empty, use `./Dockerfile` and build context `.`, and set the health check to `/api/health`.

Add `DEEPSEEK_API_KEY` in Render's private environment settings. Render provides `PORT`; no manual port value or Docker command override is needed. The deployment instructions are in `docs/release/DEPLOY.md`.

## Development

The frontend uses React, TypeScript and Vite. The server uses Python, FastAPI and Pydantic. DeepSeek `deepseek-v4-pro` creates structured lesson drafts and source explanations. Library content and stored translations are separate from the JavaScript bundle.

Default checks use local data and mocked provider responses. Run them in a disposable copy without `.env`:

```powershell
cd server
..\.venv\Scripts\python -m pytest -q
cd ..
npm --prefix web run typecheck
npm --prefix web test
npm --prefix web run build
```

Browser checks cover the teacher, learner, library, reading and assistant journeys on desktop and mobile widths. Live provider checks are separate from the default tests.

## Sources and licensing

- Quran and published translations of the meanings: https://quranenc.com/
- Fatwas: https://binbaz.org.sa/
- Hadith and published translations: https://hadeethenc.com/
- Quran recitation: https://www.mp3quran.net/ar/yasser/downloads

Project-owned code is licensed under MIT. Publisher content, recordings, fonts and other third-party material retain their own terms. See `LICENSE`, `THIRD_PARTY_NOTICES.md` and `content/notices/`.
