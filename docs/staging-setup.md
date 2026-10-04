# Staging: Railway environment + separate Supabase project + Vercel preview

Owner's steps. A staging stack that shares **nothing** with production: its own API service
deployment, its own database, its own frontend URL. Never paste a secret into chat, a PR or a doc;
set secrets by hand in the dashboards.

## Read first: previews currently talk to production

`vercel.json` rewrites `/api/*` and `/uploads/*` to the **production** Railway API for every
deployment, previews included. Until step 3 is done, anything you click on a Vercel preview reads
and writes production data. The fix below doesn't touch `vercel.json` (production keeps working
exactly as today): Preview builds get `VITE_API_URL`, which makes the app call the staging API
directly (`src/lib/apiUrl.ts`).

## 1. Database: a separate Supabase project

1. https://supabase.com/dashboard → **New project** → name `shiftsync-staging`, a strong database
   password (store it in your password manager), the region closest to where the staging API runs.
2. When it's ready: **Connect** (top bar) → **Session pooler** → copy the URI
   (`postgresql://postgres.<ref>:<password>@<region>.pooler.supabase.com:5432/postgres`, with your real password in place of `<password>`). Use the
   **session** pooler (port 5432), not the transaction pooler (6543): Prisma's migrations and
   prepared statements need a session.
3. Nothing to run in Supabase itself: the API applies every migration on its first boot
   (`server:start` runs `prisma migrate deploy`).

## 2. API: a Railway `staging` environment

1. Railway → project **shiftsync** → environment switcher → **New Environment** → **Empty
   environment** named `staging`. Do **not** duplicate production: that would copy its variables,
   including the production database reference.
2. In `staging`: **+ New** → **GitHub Repo** → `voyagerventuresdxb-max/ShiftSync` → service name
   `shiftsync-api`. Settings → Source → branch **`staging`** (create the branch on GitHub from
   `master` first). `railway.json` applies here too (same build and start commands).
3. Settings → **Volumes** → add one mounted at `/app/server/uploads` (floor plans and policy
   documents survive redeploys, as in production).
4. **Variables** (set by hand; names only here):

   | Variable | Staging value |
   |---|---|
   | `DATABASE_URL` | the Supabase session-pooler URI from step 1, with the real password — **secret** |
   | `NODE_ENV` | `production` (same safety rules as production; `RAILWAY_ENVIRONMENT_NAME` will be `staging`) |
   | `FRONTEND_ORIGIN` | the staging frontend URL from step 3 (e.g. `https://<project>-git-staging-<team>.vercel.app`) |
   | `CORS_ORIGINS` | the same staging frontend URL (Preview builds call the API cross-origin) |
   | `ALLOW_DEV_OTP_ECHO` + `ECHO_ALLOWED_PHONES` | only if you want codes on screen for staging test numbers you control |
   | AI / push variables | leave unset unless you are testing them: `docs/vlm-go-live.md`, `docs/push-go-live.md`. Use separate keys from production. |

   Must stay absent, as in production: `ALLOW_DEV_OTP_BYPASS`, `ALLOW_DEV_ERROR_INJECTION`,
   `GEMINI_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_VERTEX_BASE_URL` (boot is refused).
5. Settings → **Networking** → **Generate Domain** → note the staging API URL.
6. Deploy from the GitHub source (never `railway up`):

   ```powershell
   cd C:\dev\ShiftSync-deploy
   npx -y @railway/cli@5.63.1 redeploy --from-source --environment staging --service shiftsync-api --yes
   ```

7. Check it:

   ```powershell
   curl.exe -s https://<staging-api-domain>/api/health          # {"ok":true}
   curl.exe -s https://<staging-api-domain>/api/health/ready    # {"ok":true,"db":"ok","migrations":{"expected":N,"applied":N,"pending":0}}
   ```

   `/api/health/ready` returns 503 until every migration is applied, or if the database is
   unreachable. Each response carries an `X-Request-Id`; the same id prefixes the API's log lines
   for that request (`[rid=…]`).

## 3. Frontend: a Vercel preview environment for `staging`

1. Vercel → project → **Settings → Environment Variables** → add `VITE_API_URL` = the staging API
   URL (`https://<staging-api-domain>`, no trailing slash). Environment: **Preview** only, and
   restrict it to the **`staging`** branch. Do not add it to Production (production keeps using
   the `/api` rewrite).
2. Push to the `staging` branch. Vercel builds it with `VITE_API_URL`; the branch's stable URL
   (`…-git-staging-…vercel.app`) is the `FRONTEND_ORIGIN` / `CORS_ORIGINS` value in step 2.
3. Deployment protection applies to previews too; sign in to Vercel to open it, or add a
   bypass for your own testing.
4. Open the staging URL, sign up a test venue (with an echo-allowlisted test number, or a login
   link), and confirm in the browser's network tab that `/api` calls go to the **staging** API
   domain, not production.

## 4. Day-to-day

- Promote: merge `master` into `staging` → Vercel preview rebuilds automatically → run the
  `redeploy --from-source --environment staging` command above (pushes don't deploy the API).
- Test data: `npm run db:seed:demo` only runs against a local database (by design). On staging,
  create data through the app.
- Reset: Supabase → Database → Backups (or drop and recreate the project), then redeploy.
- Costs: Supabase's free tier pauses idle projects; Railway bills the staging service and volume
  separately from production.
