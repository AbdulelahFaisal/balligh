# Deploying Balligh on Render (proposed, not done)

Status: nothing is deployed. The GitHub repository (owner `AbdulelahFaisal`, proposed name `balligh`) has not been created or confirmed, and no Render service exists. The Docker image has never been built: Docker is not installed on the development machine. Every step below is for the owner to run.

## What runs

- One container from `app/Dockerfile`. A Node 24 stage builds `web/dist`; a Python 3.13 stage serves the web client and `/api` from one origin.
- One `uvicorn` process, no `--workers`. The two-request generation limit (`max_in_flight` 2; a third request is refused, not queued) is held per process, so it only holds with one process on one instance.
- The process listens on `${PORT}`. The image defaults to 8000; Render supplies its own `PORT`.
- It runs as the non-root user `balligh` (uid 10001), which cannot write `/app`.
- `BALLIGH_LEDGER_DIR=off` is set in the image: no generation ledger and no saved provider replies are written in the container.
- Licence texts are in `/app/licenses/`: `LICENSE` (MIT, project-owned code only), `THIRD_PARTY_NOTICES.md`, `content-notices/` (from `content/notices/`) and `fonts/OFL-*.txt`.

## Render setup (owner)

1. Push the release tree (`docs/release/RELEASE_TREE.md`) to the public GitHub repository.
2. In Render, create a **Web Service** from that repository, with **Docker** as the language/runtime. The Dockerfile is at the repository root and needs no build arguments.
3. Instance: **one** instance, no autoscaling or extra instances (see "What runs").
4. Health check path: `/api/health`.
5. Environment variables:

| Variable | Value | Notes |
|---|---|---|
| `DEEPSEEK_API_KEY` | the owner's key | Enter it as a secret in Render's environment settings. Never commit it or put it in the repository, the Dockerfile or a build argument. |
| `BALLIGH_LEDGER_DIR` | `off` | Already set in the image; setting it again in Render is harmless and makes it explicit. |
| `PORT` | do not set | Render supplies it. |

`BALLIGH_CONTENT_DIR` and `BALLIGH_WEB_DIST` stay unset; the image's paths are correct.

## Without a key

`/api/health` then reports `generation.configured: false`. Reading the library, the Learn path, recorded Quran recitation (streamed from the publisher's CDN), the Quran assistant extracts, the example lessons, and review, import and export of saved lessons all work. Creating a new AI draft and asking about a fatwa or hadith need the key.

## Free tier, cost and availability

- A free Render web service spins down when it receives no traffic. The next request waits for a cold start. Do not describe the deployment as always-on.
- There is no durable local disk. Anything written inside the container is lost on restart or redeploy. With the ledger off the server keeps no generation record, and learner progress lives in each browser only. Do not promise persistence.
- Spending ceiling: SAR 30, as previously approved; stay within it. The free instance itself costs nothing. DeepSeek calls are billed to the owner's key, and a cancelled or timed-out request may still be billed. Do not upgrade the plan without a new approval.
- Availability: one month from deployment. Afterwards the owner suspends or deletes the service and rotates the key.

## Smoke checks after deploy

Replace `<host>` with the Render URL.

1. Health: `curl -fsS https://<host>/api/health` returns `"status": "ok"`, `generation.configured: true` once the key is set, `max_in_flight: 2` and `in_flight: 0`. The key never appears in the response.
2. Home: `https://<host>/` returns HTTP 200 and the app opens.
3. Library: `https://<host>/library` opens (client route served by the SPA fallback). Open a surah under `/library/quran`, a fatwa under `/library/questions` and a hadith under `/library/hadith`; start a recitation.
4. Teacher journey (makes one billed provider call): open `/setup`, paste a short Arabic text that contains no Quran verse, generate a draft, compare and edit it in `/review`, acknowledge it, walk through `/preview` and `/learn`, then export HTML and JSON and import the JSON again.
5. Quran refusal, once the integrator's change is in the deployed build: a teacher text in which a known ayah is detected is refused before any provider request.

## Local Docker checks that were NOT run

Docker is not installed here, so none of these has been run. Run them before or right after the first deploy:

```sh
docker build -t balligh .
docker run --rm -d --name balligh-smoke -e PORT=10000 -p 10000:10000 balligh   # keyless
curl -fsS http://127.0.0.1:10000/api/health          # status ok, generation.configured false
curl -fsS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:10000/          # 200
curl -fsS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:10000/library   # 200
docker exec balligh-smoke id -u                       # 10001
docker exec balligh-smoke sh -c 'test ! -e /app/var && echo "no /app/var"'
docker diff balligh-smoke                             # expect no changes under /app
docker exec balligh-smoke ls /app/licenses /app/licenses/fonts /app/licenses/content-notices
docker stop balligh-smoke
```

## Known limits

- **Seven-language reading is an unmet release requirement.** All 100 fatwas are Arabic only (600 fatwa language pairs missing) and 31 hadith language pairs are missing (`translation-plan.md`, `translation-coverage.json`). It is not an accepted deferral.
- The translation estimates in `translation-estimate.json` (G5-B) were extrapolated from lesson-call latency. They are not measured translation benchmarks.
- The source-cited assistant is not a translation. Its answers are unreviewed AI explanations.
- Quran safeguard: the known-ayah matching is an advisory heuristic. It does not detect every quotation and misses variant spellings and partial quotations. Prompt instructions are not a guaranteed enforcement mechanism. The integrator is adding this refusal: teacher texts in which a known ayah is detected are refused before any provider request.
- Generated lessons are unreviewed AI drafts; no scholarly or language review has taken place.
- No hosted access control: anyone with the URL can use generation on the owner's key, within the two-request limit.

## Destination (G5-D)

- **Repository:** the user confirmed the public repository https://github.com/AbdulelahFaisal/balligh on 2026-10-06 at about 22:28 Riyadh as the destination for the reviewed, clean release.
- **Current state:** a read-only `git ls-remote` showed the repository exists and has no branches yet. Nothing has been pushed.
- **Before pushing:** coordinator review of the clean candidate, and a decision on the `server/tests/fixtures/json3/` and DeepSeek-output fixtures (see RELEASE_TREE.md).

## Status at publication

Pushed to https://github.com/AbdulelahFaisal/balligh (branch main); the repository root is the app root. Render (Docker, Free, Oregon, health check `/api/health`, `DEEPSEEK_API_KEY` set privately, no manual PORT) builds the image; no Docker build was run locally. Coverage: see TRANSLATION_STATUS.md (85 of 600 fatwa pairs).
