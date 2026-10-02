# Deployment — Vercel frontend + Railway API

How the live site is put together, why, and the order to do it in. Written
2026-09-22 after the MVP readiness review found that the Vercel project had
never had a live production deployment and deployed the frontend only
(`docs/mvp-readiness-report.md`, item 3.5).

> **Deploying the API: follow [`railway-deploy-procedure.md`](railway-deploy-procedure.md)**
> (pre-flight checks, the build-log lines to look for, rollback, and the move off
> `railway.json` before Railway stops reading it on 2026-12-01).
> **Never run `railway up` against the production `shiftsync-api` service.** On 2026-09-29
> it skipped `railway.json` and replaced the API with the frontend's `index.html` for about
> 7 minutes (#52). Deploy from the GitHub source only. Remove this warning only after both
> paths are proven (procedure §3).

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

   | Variable | Value / note |
   |---|---|
   | `DATABASE_URL` | the Railway Postgres URL |
   | `FRONTEND_ORIGIN` | `https://shift-sync-shift-sync1.vercel.app` — the only origin invite links are minted for (`server/src/routes/onboarding.ts`); comma-separate to add a custom domain later |
   | `GEMINI_API_KEY` | needed for voice and for image/scanned-PDF roster ingestion; Excel/CSV/text-PDF parsing works without it |
   | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | optional — push notifications are disabled without them (the server logs a one-line notice). To switch push on, follow [`push-go-live.md`](push-go-live.md). |
   | `ALLOW_DEV_OTP_ECHO` | **`true` for the MBRIF demo only** — there is no SMS integration, so this is the only way a code can be entered on the live site. It shows the real one-time code on screen to whoever requested it. Remove it right after the demo. |
   | `PORT` | injected by Railway; the server reads it |

4. Add a **Volume** mounted at `/app/server/uploads` so floor-plan images and policy
   documents survive redeploys. (Without it they are lost on every deploy — acceptable for
   a demo, not for real use.)
5. Deploy. `railway.json` runs `npm install && prisma generate` to build and
   `npm run server:start` to start (`prisma migrate deploy`, then the idempotent phone
   backfill `server/scripts/backfill-phone-e164.ts`, then `tsx server/src/index.ts`), with
   `/api/health` as the health check. The backfill never blocks a start, and its one log line
   (`[phone-e164] …`) says how many stored phones it moved to E.164 and which user ids
   it left as stored. Search the deploy log for it after any deploy that touches phones. (`npm install`, not `npm ci`: the committed lockfile does not pass `npm ci`
   — see the readiness report.)
6. Settings → Networking → *Generate Domain*. That `https://<service>.up.railway.app` is
   the `RAILWAY_API_HOST` below.

Verify before touching Vercel: `curl https://<service>.up.railway.app/api/health` must
return `{"ok":true}`.

### 2. Vercel rewrite

Replace `RAILWAY_API_HOST` in `vercel.json` with the Railway domain (host only, no scheme
— the file already carries `https://`), commit to `master`. Vercel builds every push as a
*preview* until step 3.

The frontend build is `prisma generate && tsc -b && vite build`. `tsc -b` type-checks the
e2e specs, which import the generated Prisma client, and Vercel restores `node_modules`
from its build cache — so `@prisma/client`'s own postinstall `generate` does not re-run and
the client can be older than `prisma/schema.prisma`. That broke the #49 preview (new
`FloorSection.pinX` "does not exist"). `prisma generate` needs no database connection.
Railway already generates in its own build command.

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
