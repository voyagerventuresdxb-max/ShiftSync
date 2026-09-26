# Deployment — Vercel frontend + Railway API

How the live site is put together, why, and the order to do it in. Written
2026-09-22 after the MVP readiness review found that the Vercel project had
never had a live production deployment and deployed the frontend only
(`docs/mvp-readiness-report.md`, item 3.5).

## Shape

```
browser ── https://shift-sync-shift-sync1.vercel.app ── Vercel (static Vite build)
                │
                │  vercel.json rewrites  /api/*  and  /uploads/*
                ▼
         https://<service>.up.railway.app ── Railway (Express API, `tsx server/src/index.ts`)
                │
                ▼
         Postgres (Railway Postgres — see "Which database")
```

The frontend only ever calls relative `/api/...` and `/uploads/...` URLs, so it needs no
build-time API URL: Vercel proxies those paths to Railway server-side (same origin for the
browser, no CORS in play). Everything else falls back to `index.html` so deep links such as
`/onboarding/venue` survive a reload.

## Why not Vercel serverless for the API

The Express server writes to local disk (floor-plan images and policy documents under
`server/uploads/`, the 15-minute upload-preview cache in `.upload-cache.json`, PDF
rasterizing temp files) and can optionally talk to a Python sidecar (Docling). None of that
fits a serverless filesystem without a storage refactor. A plain Node host runs the server
exactly as the test suite and the readiness click-through ran it.

## Which database

Use a **fresh Railway Postgres** for production, not the old shared Supabase instance.
MEMORY.md records that the Supabase DB had migrations applied by hand (`prisma db execute`)
and migrations applied that have no files in `prisma/migrations/` — `prisma migrate deploy`
against it is not guaranteed to be clean. A fresh database applies the whole migration
history from scratch, which is exactly what `server:start` does on every boot.

## One-time setup (in this order)

### 1. Railway service (API)

1. New project → *Deploy from GitHub repo* → `voyagerventuresdxb-max/ShiftSync`, branch
   `master`. Root directory: `/` (the repo root — `railway.json` there sets the build and
   start commands; do not point it at `server/`).
2. Add a **Postgres** plugin to the project; copy its `DATABASE_URL` into the API service's
   variables (Railway can reference it as `${{Postgres.DATABASE_URL}}`).
3. Variables on the API service (names only — never paste values into chat or docs):

   See "Required in production" and "Must be OFF in production" below for the full
   lists — this table is the same content in setup order.

   | Variable | Value / note |
   |---|---|
   | `NODE_ENV` | `production`. Nothing in the repo sets this; the host must. It is what arms the boot-time refusal of the dev flags below (`server/src/lib/productionGuards.ts`). |
   | `DATABASE_URL` | the Railway Postgres URL |
   | `FRONTEND_ORIGIN` | `https://shift-sync-shift-sync1.vercel.app` — the CORS allowlist and the only origin invite links are minted for (`server/src/lib/frontendOrigins.ts`); comma-separate to add a custom domain later. **The server refuses to start in production without it.** |
   | `TRUST_PROXY` | `2` — number of reverse-proxy hops in front of the API (Railway's edge + the Vercel rewrite), so the per-IP login rate limits see the real client address instead of Vercel's. Set `1` if the API is ever called directly rather than through Vercel. |
   | `LOGIN_METHODS` | leave unset (= `links`): people sign in with one-time login links only and the phone-code (OTP) routes answer 403. `otp` re-enables the phone-code flows — only once real SMS/WhatsApp delivery exists. |
   | `LOGIN_LINK_TTL_HOURS` | optional, default `24` — how long an issued login link stays redeemable. Also quoted in the share text. |
   | `GEMINI_API_KEY` | needed for voice and for image/scanned-PDF roster ingestion; Excel/CSV/text-PDF parsing works without it |
   | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | optional — push notifications are disabled without them (the server logs a one-line notice) |
   | `PORT` | injected by Railway; the server reads it |

   There is still no SMS integration, so a one-time code cannot reach a real phone on
   the live site. Do **not** work around that with `ALLOW_DEV_OTP_ECHO` (see below) —
   it lets anyone who knows a phone number log in as that person. One-time login links
   shared by a manager are the planned replacement.

### Getting the first people in (login links)

There is no self-signup in links mode. Two operator-only scripts, run on the API
host (`tsx` is installed there); neither has an API equivalent by design:

```
tsx server/scripts/create-org-shell.ts --venue "Il Gattopardo" --owner "Layla Haddad" --phone +971501234567
    → creates the venue shell (Organization + Location + OWNER + default roles) and prints the
      owner's first login link. Send it on WhatsApp; their tap lands in the onboarding wizard at Venue.
tsx server/scripts/grant-platform-admin.ts +971501234567
    → flags that user as platform admin (may issue links to any venue's owners/managers from the app).
```

Locally the same scripts run as `npm run org:create -- …` and `npm run admin:grant -- …`
(against the current branch's schema). From then on: owners send links to their managers and
staff, managers to their staff — Staff Directory → "Send login link" → share sheet.

### Required in production

The API refuses to start (`Refusing to start with NODE_ENV=production: …` in the deploy
log, health check never goes green) unless all of these hold:

- `NODE_ENV=production`
- `FRONTEND_ORIGIN` set to the real frontend origin(s)
- none of the "Must be OFF" flags below set to `true`

Also needed for a working deployment, though the server will boot without them:
`DATABASE_URL`, `TRUST_PROXY=2`, `GEMINI_API_KEY` (AI features), the three `VAPID_*`
values (push).

### Must be OFF in production

Every one of these is opt-in (only the literal string `true` enables it) and exists for
local development or tests only. Leave them unset on Railway.

| Flag | What it does if on | In production |
|---|---|---|
| `ALLOW_DEV_OTP_BYPASS` | the fixed code `000000` verifies for **any** phone number | **server refuses to start** |
| `ALLOW_DEV_ERROR_INJECTION` | a sentinel bearer token deliberately crashes session auth (test hook) | **server refuses to start** |
| `ALLOW_DEV_OTP_ECHO` | returns the real one-time code to whoever requested it (`devCode` in the response and a plaintext log line) — i.e. anyone can log in as any phone number | boots, but logs a `[SECURITY]` warning at startup and beside every echoed code. Turn it off. |
| `VLM_FALLBACK_MODE` | `off` disables the local text-layer parse when Gemini is unavailable. The old `sample` value (a canned demo roster shown in place of the manager's file) no longer exists and is treated as `auto`. | leave unset (`auto`) |

4. Add a **Volume** mounted at `/app/server/uploads` so floor-plan images and policy
   documents survive redeploys. (Without it they are lost on every deploy — acceptable for
   a demo, not for real use.)
5. Deploy. `railway.json` runs `npm install && prisma generate` to build and
   `prisma migrate deploy && tsx server/src/index.ts` to start, with `/api/health` as the
   health check.
6. Settings → Networking → *Generate Domain*. That `https://<service>.up.railway.app` is
   the `RAILWAY_API_HOST` below.

Verify before touching Vercel: `curl https://<service>.up.railway.app/api/health` must
return `{"ok":true}`.

### 2. Vercel rewrite

Replace `RAILWAY_API_HOST` in `vercel.json` with the Railway domain (host only, no scheme
— the file already carries `https://`), commit to `master`. Vercel builds every push as a
*preview* until step 3.

### 3. Vercel Production Branch — last

Vercel dashboard → the `shift-sync` project → Settings → Git → **Production Branch =
`master`**. This is a dashboard-only setting; the CLI cannot change it. The next push to
`master` (or `vercel --prod` from a checkout of master) becomes the first live production
deployment. Deliberately last, so the first thing that goes live is the working
combination, not a frontend whose `/api` calls 404.

Then verify on the production URL, not a preview (previews sit behind Vercel SSO):

```
curl https://shift-sync-shift-sync1.vercel.app/api/health        → {"ok":true}
open  https://shift-sync-shift-sync1.vercel.app/onboarding       → Welcome intro renders
sign up a throwaway venue end to end (Account → Venue → Roster upload → Review → Invite)
open  https://shift-sync-shift-sync1.vercel.app/onboarding/venue → reload survives (SPA fallback)
```

## Rollback

- API: Railway → Deployments → *Redeploy* a previous green deployment.
- Frontend: Vercel → Deployments → *Promote to Production* on an earlier build, or push a
  revert to `master`.
- Both are independent; the rewrite in `vercel.json` is the only coupling.

## Local development is unchanged

`npm run db:setup` + `npm run dev:all` — docker Postgres, per-branch schema, Vite proxying
`/api` to `localhost:4000`. Nothing here reads `vercel.json` or `railway.json`.
