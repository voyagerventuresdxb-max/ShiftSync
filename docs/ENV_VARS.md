# Environment variables — the canonical list

Every environment variable ShiftSync's own code reads, where it is read, and what production
needs. Names only: **never put a secret value in this file, in a PR, or in chat.**
Deploy steps live in [`deployment.md`](deployment.md); this file is the reference it points to.

Rows marked **(from #63)** / **(from #69)** describe variables or behaviour that arrive with
those open PRs and are not on this branch yet. PR #61 adds no environment variables.

How values are loaded:

- The API loads `.env` from the working directory (`import 'dotenv/config'` in
  `server/src/index.ts`). Every npm script that touches the database runs through
  `scripts/with-branch-schema.mjs`, which loads `.env` too (`process.loadEnvFile()`). Neither
  overrides a variable already set in the shell or by the host, so shell/host values win.
- The `ALLOW_DEV_*` flags are on only when the value is exactly `true` (lowercase).
  `TRUE`, `1` or `yes` leave them off.
- `.env` exists only locally. It is gitignored, and copied from `.env.example` by
  `npm run db:setup` when missing. Production values live in the Railway service variables.

## 1. API server (`server/src`) — runtime

| Name | Purpose | Required in production? | Safe default | Where read |
|---|---|---|---|---|
| `DATABASE_URL` | Postgres connection string for Prisma. | **yes** | none — must be set. Local: the docker URL in `.env.example`. | `prisma/schema.prisma:12`, `server/src/lib/prisma.ts:20` |
| `PORT` | Port the Express API listens on. | yes, injected by Railway (don't set it by hand) | `4000` | `server/src/index.ts:5` |
| `NODE_ENV` | `production` arms the boot-time refusal rules (§5) and makes `prisma.ts` use `DATABASE_URL` as-is, with no `git`-derived `dev_<branch>` schema. It also makes `npm install` skip devDependencies. | **yes**, `production` (Railpack also sets it in the image **(from #63)**, but set it on the service anyway) | unset locally. Never set `production` in a dev worktree: it turns off the per-branch-schema fallback. | `server/src/lib/productionGuards.ts:11`, `server/src/lib/prisma.ts:22,36` |
| `RAILWAY_ENVIRONMENT_NAME` | Injected by Railway. `production` counts as production for the refusal rules, even without `NODE_ENV`. | injected by Railway | unset locally | `server/src/lib/productionGuards.ts:11` |
| `FRONTEND_ORIGIN` | Comma-separated allowlist of frontend origins. Invite and kiosk links use the caller's origin only if it is listed. Login links always use the **first** entry. | **yes** (`https://shift-sync-shift-sync1.vercel.app`) | `http://localhost:5173` when unset | `server/src/lib/inviteLinks.ts:20`. Login links read it through `server/src/lib/loginLinks.ts:37`. |
| `CORS_ORIGINS` | Comma-separated browser origins allowed to call the API cross-origin (the Capacitor app at `https://localhost`, a staging frontend that uses `VITE_API_URL`). Unset or empty: any origin, as before it existed. The production web app never needs listing — it is same-origin through the Vercel rewrite. | no (staging: the staging frontend URL) | unset (any origin) | `server/src/lib/corsOptions.ts` |
| `ALLOW_DEV_OTP_ECHO` | Returns the one-time code in the request-otp response (`devCode`) and logs it, but only for numbers in `ECHO_ALLOWED_PHONES`. It is the only way to receive a code while there is no SMS provider (#51). | conditional: `true` only for a demo with no SMS, and only together with `ECHO_ALLOWED_PHONES`. Remove it afterwards. | unset (off) | `server/src/lib/devOtpEcho.ts:12` |
| `ECHO_ALLOWED_PHONES` | Comma-separated mobile numbers, in any format `toE164` accepts, whose code may be echoed. Invalid entries are ignored with a `[startup]` warning. | conditional: **required whenever `ALLOW_DEV_OTP_ECHO=true` in production** (otherwise boot is refused). Anyone who knows a listed number can sign in as it, so list only numbers you control. | empty (no number is echoed) | `server/src/lib/devOtpEcho.ts:19` |
| `SMS_OTP_ENABLED` | `true` = every request-otp route also texts the code (Twilio Programmable Messaging); a failed send answers `503` with a retry message. Anything else: no SMS, exactly as before. See `docs/otp-delivery-uae.md` before turning it on. | no. Off until a UAE sender ID is registered. **If `true` in production, the three provider settings below are required (otherwise boot is refused).** | unset (off) | `server/src/lib/sms.ts` |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio account credentials for the SMS sender. The token is a secret. | only with `SMS_OTP_ENABLED=true` | unset | `server/src/lib/sms.ts` |
| `TWILIO_MESSAGING_SERVICE_SID` or `SMS_SENDER_ID` | Who the text comes from: a Messaging Service (preferred; carries the registered UAE sender ID) or a sender ID / number used as `From`. One of the two. | only with `SMS_OTP_ENABLED=true` | unset | `server/src/lib/sms.ts` |
| `ALLOW_DEV_OTP_BYPASS` | Makes the fixed code `000000` verify for **any** phone. | **must be absent.** Boot is refused if it is `true`. | unset (off) | `server/src/lib/identity.ts:26` |
| `ALLOW_DEV_ERROR_INJECTION` | Arms a sentinel bearer token that makes `requireSession` throw. Used by the e2e error-handling spec. | **must be absent.** Boot is refused if it is `true`. | unset (off) | `server/src/middleware/requireSession.ts:33` |
| `LOGIN_METHODS` | `links` = one-time login links only: the six phone-code routes answer `403 otp_disabled` and the app hides the phone forms. Any other value, or unset, allows both codes and links. | no. **Leave unset.** | unset (codes and links both on) | `server/src/lib/loginLinks.ts:24` |
| `LOGIN_LINK_TTL_HOURS` | How long a newly issued login link stays redeemable. The share text quotes it too. | no | `24`. Non-numbers and values ≤ 0 fall back to `24`. | `server/src/lib/loginLinks.ts:8` |
| `VAPID_PUBLIC_KEY` | Web Push public key. `/api/push/vapid-public-key` serves it. | no. Push is off without it, and the API logs `[push] … disabled`. | empty (push off) | `server/src/lib/push.ts:9` |
| `VAPID_PRIVATE_KEY` | Web Push private key. **Secret.** | no. Needed together with `VAPID_PUBLIC_KEY`. | empty (push off) | `server/src/lib/push.ts:10` |
| `VAPID_SUBJECT` | Contact URI sent to push services. Must start with `mailto:` or `https:`. | no (only used when both keys are set) | `mailto:ops@example.com` | `server/src/lib/push.ts:11` |
| `GEMINI_API_KEY` | Gemini Developer API key. **Secret.** Voice (transcribe + intent) needs it. Roster vision uses it only when Vertex isn't configured (local dev). | conditional: for voice (without it the voice routes answer `503`). Production vision should use Vertex instead. One key per environment: the free tier allows 20 requests/day per key. | unset (voice off; vision not configured) | `server/src/lib/aiConfig.ts` (`developerApiKey`), `server/src/voice/model.ts` (`voiceClientOptions`) |
| `GEMINI_VERTEX_PROJECT` | GCP project id. When set, roster vision uses Vertex AI instead of the Developer API. Voice does not use it. | for production vision (see [`vlm-go-live.md`](vlm-go-live.md)) | unset (vision on the Developer API if a key is set, else not configured) | `server/src/lib/aiConfig.ts` |
| `GEMINI_VERTEX_LOCATION` | Vertex AI location. The default models are offered only on `global` and the `us` / `eu` multi-regions, **not** in single regions such as `europe-west4` (Google's docs, checked 2026-10-04); `eu` keeps processing in the EU. | no | `eu` | `server/src/lib/aiConfig.ts` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to a service-account JSON key **file** for Vertex (Application Default Credentials; google-auth-library reads it, not our code). Fine on a machine; Railway can't mount a file, so use `GOOGLE_SERVICE_ACCOUNT_JSON` there. | no | unset | the `@google/genai` / google-auth-library dependency |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The whole service-account key file's JSON, pasted as one **secret** variable — the way to give Vertex credentials on Railway. Takes precedence over `GOOGLE_APPLICATION_CREDENTIALS`. A malformed value is reported without echoing any of it. | for production vision on Railway (with `GEMINI_VERTEX_PROJECT`) | unset (Application Default Credentials) | `server/src/lib/aiConfig.ts` (`vertexCredentials`) |
| `GEMINI_HTTP_TIMEOUT_MS` | Per-request timeout for roster-vision Gemini calls. | no | `30000` | `server/src/lib/aiConfig.ts` |
| `VLM_MODEL` | Primary Gemini model for roster vision. A 404 for it (retired/misspelled/not in this location) is logged as `[vision] MODEL NOT AVAILABLE …` and the fallback model is tried. | no | `gemini-3.6-flash` (GA; no retirement announced, checked 2026-10-04) | `server/src/lib/aiConfig.ts` |
| `VLM_FALLBACK_MODEL` | Model retried after a 429/503/404 from the primary. If every model answers 404 the upload gets `vision_model_unavailable` ("…until its AI model setting is updated…"). | no | `gemini-3.5-flash-lite` (GA; retirement "July 21, 2027 or later" on Vertex) | `server/src/lib/aiConfig.ts` |
| `VLM_FALLBACK_MODE` | What vision does when Gemini can't be used. `auto`: a PDF with a text layer, or a spreadsheet grid, goes to the deterministic local parser (still the manager's own data); an image or image-only PDF fails with a coded 422 (`vision_unconfigured` / `vision_busy` / `vision_model_unavailable` / `vision_failed`). `off`: always the coded error. The old `sample` value no longer exists (logged and treated as `auto`); no built-in sample roster is ever returned. | no | `auto` | `server/src/parsing/parseVision.ts` (`fallbackMode`) |
| `VOICE_MODEL` | Gemini model for both voice stages. A 404 for it is logged as `[voice.*] MODEL NOT AVAILABLE …` and the user is told voice is switched off until the setting is updated (`503 voice_model_unavailable`). | no | `gemini-3.6-flash` | `server/src/lib/aiConfig.ts` (read through `server/src/voice/model.ts`) |
| `ROSTER_ESCALATE_EMPTY_ROLE_SHARE` | Share (0–1) of a day-grid roster's shift rows with no role above which the upload offers the AI reader (with the manager's consent) instead of trusting the built-in result. ALL-CAPS-only rosters, a proven parse data-loss, unrecognised layouts and photos/scans escalate regardless. | no | `0.3`; values outside 0–1 or non-numbers use the default | `server/src/lib/aiConfig.ts` (`escalationConfig`) |
| `UPLOAD_CACHE_FILE` | JSON file that persists roster-upload previews for 15 minutes, between preview and confirm. | no | `server/.upload-cache.json` | `server/src/store/uploadCache.ts:21` |
| `DOCLING_SIDECAR_HOST` | URL of the optional Docling table-extraction sidecar (`npm run docling:sidecar`), tried first for scanned PDFs. | no. If it is unreachable, scanned PDFs go to Gemini. | `http://127.0.0.1:8901` | `server/src/parsing/doclingClient.ts:33` |
| `DOCLING_TIMEOUT_MS` | Timeout for one Docling conversion. | no | `90000` | `server/src/parsing/doclingClient.ts:38` |
| `DOCLING_PYTHON_PATH` | Python interpreter that runs `server/docling-sidecar/rasterize_pdf.py`, which turns PDF floor plans into PNGs. | conditional: only to accept **PDF** floor plans. Without it, a PDF upload answers `422` and asks for a PNG/JPG. | `server/docling-sidecar/.venv/Scripts/python.exe` (a Windows venv path, so absent on Railway) | `server/src/parsing/pdfRasterize.ts:35` |

Behaviour that changes with **#63**: on this branch, a malformed VAPID value (a bad key, or a
subject without `mailto:`/`https:`) makes `web-push` throw while `push.ts` loads, and the API
fails to boot. With #63 the API logs `[push] VAPID config rejected …` and runs with push off,
and `npm run vapid:generate` prints a fresh pair to the terminal only.

## 2. Frontend build (`src/`, Vite, Vercel)

| Name | Purpose | Required? | Safe default | Where read |
|---|---|---|---|---|
| `VITE_API_URL` | Build-time API origin. Set: every `/api` and `/uploads` URL becomes absolute to that origin (the Capacitor Android build, and Vercel **Preview** builds pointed at staging — see [`staging-setup.md`](staging-setup.md)). Unset: relative URLs, proxied by Vercel's rewrite to the Railway host hard-coded in `vercel.json`. | **never on Vercel Production**; Preview (staging branch) and app builds only | unset (relative URLs) | `src/lib/apiUrl.ts` |

Production needs no Vercel variables. Note that `vercel.json`'s rewrite sends **every** deployment's
`/api` traffic, previews included, to the production API unless `VITE_API_URL` is set for them.
`vite.config.ts` reads none (fixed port `5173`, proxy to `localhost:4000`). The Vercel build runs
`prisma generate`, which needs no database connection.

## 3. Scripts and CLI

| Name | Purpose | Required in production? | Safe default | Where read |
|---|---|---|---|---|
| `DATABASE_URL` | Base URL. The wrappers rewrite its `schema=` parameter to `dev_<branch>` (and `connection_limit` for `test:server`) before running the wrapped command. | yes on Railway: `server:start` runs `prisma migrate deploy` and the phone backfill against it, unwrapped | the docker URL in `.env.example` (`schema=public`, rewritten at run time) | `scripts/with-branch-schema.mjs:134`, `scripts/setup-local-db.mjs:71`, `scripts/bootstrap-branch-schema.mjs:55`, `scripts/check-migration-drift.mjs:29` |
| `POSTGRES_PORT` | Host port for the local docker Postgres. Only needed when 5432 is taken, and then the port in `DATABASE_URL` must match. | no, local only | `5432` | `scripts/setup-local-db.mjs:35`, `docker-compose.yml:32` |
| `GEMINI_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON` | `server/scripts/check-env-load.ts` reports whether each loaded and whether it is wrapped in quotes or whitespace. It prints no part of either value. | no | — | `server/scripts/check-env-load.ts` |
| every vision variable above | `npm run vlm:check` (`server/scripts/vlm-check.ts`) sends one tiny synthetic roster image through the configured provider and prints backend, model, region, latency, tokens and PASS/FAIL (exit 0 / 1 / 2 = not configured). No credential material, project id or provider error text is printed. Production: `railway run npm run vlm:check`. | no | — | `server/scripts/vlm-check.ts` |

Not configurable by environment:

- The local Ollama bridge (`npm run local`, `scripts/ollama-exec.cjs`) hard-codes
  `http://127.0.0.1:11434`. The API has no Ollama path any more.
- `npm run swarm` / `sparc` set `NODE_OPTIONS` inline (`cross-env`).
- `docker-compose.yml` fixes `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` to
  `dev` / `dev` / `shiftsync_dev`. They are local-only and not read from `.env`.
- Agent tooling under `.ai/`, `.claude/` and `.claude-flow/` reads its own variables. It is
  not app config.

## 4. Tests, e2e and dev-only

| Name | Purpose | Required in production? | Safe default | Where read |
|---|---|---|---|---|
| `E2E_RUN_ID` | Run id. Seeds this run's echo-phone block and the file that counts which phones were handed out. | **must be absent** (test only) | `playwright.config.ts` sets it (`??=` `Date.now()`) | `playwright.config.ts:7`, `e2e/helpers.ts:17` |
| `E2E_ECHO_PHONES` | This run's pool of 300 `+97156…` numbers. Passed to the API as `ECHO_ALLOWED_PHONES` and handed out by `nextEchoPhone()`. | **must be absent** | set by `playwright.config.ts` | `playwright.config.ts:10`, `e2e/helpers.ts:17` |
| `PUSH_TRANSPORT` | `record`: push sends go to an in-memory outbox (`GET /api/dev/push-outbox`, mounted only then) instead of a push service, and no VAPID key is needed or served. Lets e2e specs check who was notified with what. | **must be absent** — any value refuses boot (§5) | unset (real delivery when VAPID is set) | `server/src/lib/push.ts`; set by `playwright.config.ts` for the e2e API |
| `E2E_LIVE` | Set by `npm run test:e2e:live`: runs only the `@live`-tagged specs (real external services). Normal runs exclude `@live` (`grepInvert`). | **must be absent** | unset | `playwright.config.ts` |
| `ALLOW_DEV_OTP_ECHO`, `ECHO_ALLOWED_PHONES`, `ALLOW_DEV_ERROR_INJECTION` | Set on the API that Playwright starts (`webServer.env`). An API that is already running and gets reused keeps its own values and won't echo this run's phones. | see §1 | set by `playwright.config.ts` | `playwright.config.ts:56` |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | Use a system Chromium instead of Playwright's managed build. | no | unset (managed browser) | `playwright.config.ts:41` |
| `CI` | When set, Playwright always starts its own API and Vite servers (`reuseExistingServer: false`). | no | unset (reuse running servers) | `playwright.config.ts:51,62` |
| `GEMINI_API_KEY` | `test:server` live voice cases skip without it. **(from #69)** `e2e/golden-path.live.spec.ts` needs it on the API, where a `503` means it is missing or the quota is spent. | — | unset (live cases skipped) | `server/src/routes/voice.test.ts:1231` (and five more gates) |
| `DOCLING_SIDECAR_HOST` | The live Docling test skips when the sidecar is unreachable. | — | `http://127.0.0.1:8901` | `server/src/parsing/doclingClient.test.ts:17` |
| `FRONTEND_ORIGIN`, `LOGIN_LINK_TTL_HOURS`, `LOGIN_METHODS`, `ALLOW_DEV_OTP_ECHO`, `ECHO_ALLOWED_PHONES` | Server tests set these in-process and restore them afterwards. Nothing needs setting. | — | — | `server/src/routes/onboarding.test.ts`, `loginLinks.test.ts`, `devOtpEcho.test.ts` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` **(from #69)** | The rota golden-path push e2e needs a real pair in `.env` to deliver a push to its local receiver. | see §1 | unset (that spec fails its precondition) | `e2e/golden-path.spec.ts` on `rebase/rota-v0-on-master` |
| `NODE_EXTRA_CA_CERTS` **(from #69)** | Node built-in. Makes the API trust the e2e push-sink's self-signed certificate. Set it **only** in the test command's environment, never in `.env`. | **must be absent** | unset | `scripts/e2e-push-sink-cert.mjs` prints the command on `rebase/rota-v0-on-master` |
| `NOTIFY_USER_ID` **(from #63)** | Internal to `server/src/lib/push.test.ts`, which passes it to the child process the test spawns. | **must be absent** | — | `server/src/lib/push.test.ts` on `chore/railway-config-as-code-vapid` |

## 4b. Health and request ids (no variables)

- `GET /api/health`: liveness only, `{"ok":true}`, never touches the database (Railway's healthcheck).
- `GET /api/health/ready`: `200` when the database answers and every migration folder shipped with the build is applied, else `503`; the body has counts only (`db`, `migrations.expected/applied/pending`). `server/src/lib/readiness.ts`.
- Every response carries `X-Request-Id` (a safe incoming one is kept). Log lines written while handling a request are prefixed `[rid=<first 8>]`, and phone-number shapes are masked in all server logs (`server/src/lib/requestContext.ts`).

## 5. Production refusal rules

`server/src/index.ts` calls `checkProductionEnv()` (`server/src/lib/productionGuards.ts`)
before building the app. Production means `NODE_ENV=production` **or**
`RAILWAY_ENVIRONMENT_NAME=production`. In production the API logs
`[startup] Refusing to start in production …`, naming every offending setting, and exits 1
before listening, so the deploy fails its health check. It does this when any of these hold:

- `ALLOW_DEV_OTP_ECHO=true` and `ECHO_ALLOWED_PHONES` has no valid mobile number;
- `ALLOW_DEV_OTP_BYPASS=true`;
- `ALLOW_DEV_ERROR_INJECTION=true`;
- any non-blank value in `GEMINI_BASE_URL` (our dev/e2e seam for the voice clients), `GOOGLE_GEMINI_BASE_URL` or
  `GOOGLE_VERTEX_BASE_URL` (the two overrides the `@google/genai` SDK itself honours for every client, roster
  vision included). Any of these would send Gemini/Vertex traffic to another host.
- `SMS_OTP_ENABLED=true` without `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and one of
  `TWILIO_MESSAGING_SERVICE_SID` / `SMS_SENDER_ID` (every code request would fail).
- any non-blank value in `PUSH_TRANSPORT` (the e2e push seam: sends would be recorded in memory, never delivered).

Outside production the echo-without-allowlist and SMS-without-provider cases are only `[startup]` warnings, and
invalid `ECHO_ALLOWED_PHONES` entries are always a warning, never fatal.

## 6. Production checklist

**Railway API service: must be set**

- [ ] `DATABASE_URL`: the Railway Postgres reference (`${{Postgres.DATABASE_URL}}`), not a literal URL copied from another environment.
- [ ] `NODE_ENV=production`
- [ ] `FRONTEND_ORIGIN=https://shift-sync-shift-sync1.vercel.app` (comma-separate to add a custom domain. The first entry is the one login links use.)
- [ ] `GEMINI_API_KEY`, if voice or image rosters should work (this environment's own key). Or Vertex for vision: `GEMINI_VERTEX_PROJECT` plus `GOOGLE_SERVICE_ACCOUNT_JSON` (see [`vlm-go-live.md`](vlm-go-live.md)). Voice still needs `GEMINI_API_KEY`.
- [ ] Optional: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:`/`https:`). Set all three or none.
- [ ] Demo without SMS only: `ALLOW_DEV_OTP_ECHO=true` **and** `ECHO_ALLOWED_PHONES` (demo numbers you control). Remove both afterwards.
- [ ] SMS go-live only (after the UAE sender ID is approved): `SMS_OTP_ENABLED=true`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` (or `SMS_SENDER_ID`).
- `PORT` and `RAILWAY_ENVIRONMENT_NAME` are injected by Railway. Don't set them.

**Railway API service: must be absent**

- [ ] `ALLOW_DEV_OTP_BYPASS` (boot refused)
- [ ] `ALLOW_DEV_ERROR_INJECTION` (boot refused)
- [ ] `ALLOW_DEV_OTP_ECHO` without `ECHO_ALLOWED_PHONES` (boot refused)
- [ ] `GEMINI_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_VERTEX_BASE_URL` (boot refused)
- [ ] `PUSH_TRANSPORT` (boot refused)
- [ ] `VLM_FALLBACK_MODE=sample` (obsolete: now logged and treated as `auto`; remove it)
- [ ] `LOGIN_METHODS` (leave unset: codes and links both stay on)
- [ ] Anything from §4: `E2E_*`, `CI`, `PLAYWRIGHT_*`, `NODE_EXTRA_CA_CERTS`. Also `POSTGRES_PORT` and `DOCLING_*` (no sidecar runs on Railway).

**Vercel:** no environment variables.
