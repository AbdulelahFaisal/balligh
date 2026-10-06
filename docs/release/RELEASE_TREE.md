# Public release tree

This lists what goes into the public GitHub repository (owner `AbdulelahFaisal`, proposed name `balligh`; not created or confirmed) and what stays out. Paths are relative to `app/`, which becomes the repository root. Nothing local is deleted or moved: the excluded files stay in the local handoff folder, and the review history stays where it is.

## Included

```
LICENSE                     MIT, project-owned code only
THIRD_PARTY_NOTICES.md      package, font, content and recitation notices
README.md
Dockerfile
.dockerignore
.gitignore
.env.example                variable names only, no values
docs/release/               DEPLOY.md, RELEASE_TREE.md, translation-plan.md,
                            translation-coverage.json, translation-estimate.json
server/
  balligh/                  the FastAPI service (api, pipeline, assistant, library, providers, ingestion, ...)
  tests/                    pytest suite, conftest.py, helpers.py
    fixtures/               g4b, json3, library, live, quran-source-samples
  tools/                    build_fixtures.py, live_*.py, library/ (refresh, importers, verifier)
  pytest.ini
  requirements.txt
  requirements-dev.txt
  requirements.lock         pip freeze record, not used by the build
web/
  src/                      React client, including design/fonts/ (woff2 subsets and OFL-*.txt)
  e2e/                      provider-free browser tests
  e2e-live/                 live journey (needs a key; run only through playwright.live.config.ts)
  public/                   empty today, so Git will not track it
  index.html
  package.json
  package-lock.json
  playwright.config.ts
  playwright.live.config.ts
  tsconfig.json
  vite.config.ts
content/
  assistant/ evidence/ examples/ glossary/ learn/ sources/
  library/                  quran, fatwa, hadith, adapters, quran-audio (timing and page metadata only)
  notices/                  SOURCE_NOTICES_G4-A_ingestion.md, SOURCE_NOTICES_G4-A-P1_corrections.md
tools/
  run_checks.sh
  serve_offline.py
```

## Excluded

| Path or pattern | Why |
|---|---|
| `.env`, `.env.*` (except `.env.example`), `*.pem`, `*.key`, `cookies*.txt` | Secrets. Never committed. |
| `docs/review/` | Review history and evidence (G1 through G5-C, coordinator inputs). It stays local. |
| `.claude/` | Local agent settings. |
| Prompts and handoff material outside `app/` | Not part of the app. |
| `*.zip`, `*.tar`, `*.tar.gz`, `*.tgz`, `*.7z`, `*.rar` | Archives, including review packages. |
| `*.log`, `web/test-results/`, `web/test-results-live/`, `web/playwright-report/` | Logs and test output. |
| `__pycache__/`, `*.pyc`, `.pytest_cache/`, `.vite/`, `*.tsbuildinfo` | Caches. |
| `node_modules/`, `.venv/` | Installed dependencies; recreated with `npm ci` and `pip install`. |
| `web/dist/` | Build output; the Docker image builds it. |
| `var/` | Run-time ledger, saved provider replies, library cache, staging and candidate folders. |
| `*.wav`, `*.mp3`, `*.m4a`, `*.ogg`, `recordings/` | Audio recordings. The recitation is streamed, not bundled. |

`.gitignore` already covers everything above except `docs/review/`, `.claude/` and the non-zip archive patterns (`*.tar`, `*.tar.gz`, `*.tgz`, `*.7z`, `*.rar`). Leave those out of the first commit by hand, or add them to `.gitignore` before pushing. No prompt files live inside `app/`; `server/tests/test_prompt_contract.py` is a test and is included.

## Open points before pushing

- `server/tests/fixtures/json3/` holds preexisting user-supplied captions whose rights are unknown. `THIRD_PARTY_NOTICES.md` says not to publish them publicly until rights are checked. The owner must confirm the rights or leave the folder out; tests that read those fixtures would then fail (not checked).
- Model output in `server/tests/fixtures/live/` is DeepSeek output; `THIRD_PARTY_NOTICES.md` asks for a check of DeepSeek's terms before redistributing it outside review.
- The browser tests in `web/e2e/` write their evidence (screenshots, downloads, test inputs) under `docs/review/…` and create those folders when run. In the public tree that output must stay uncommitted. No server test references `docs/`.
- The Docker image was never built (no Docker on the development machine); see `DEPLOY.md`.

## Status at publication

`content/translations/` (600 AI-assisted fatwa translations) is part of the tree. `docs/review/` and `.claude/` are excluded. The JSON3 caption fixtures are team-authored synthetic files.
