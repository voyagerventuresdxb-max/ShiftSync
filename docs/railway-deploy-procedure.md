# Railway API deploy procedure

How to deploy the `shiftsync-api` service on Railway without repeating the 2026-09-29
incident (#52), and how to move its build/run settings off `railway.json` before Railway
stops reading that file on **2026-12-01**. Written 2026-10-02. Nothing in this document has
been applied to Railway yet: no setting, variable or deploy was changed while writing it.

> **Never run `railway up` against the production `shiftsync-api` service.** On 2026-09-29
> `railway up` (CLI 5.63.1) did not apply `railway.json`. Railpack auto-detected a Vite
> static site, there was no healthcheck, and every `/api/*` route returned `index.html` for
> about 7 minutes. Deploy production from the GitHub source only. This rule stays until §3
> below has passed on a non-production environment **and** on production.

## 0. What controls a deploy

| Source | Read by | What it can set |
|---|---|---|
| `railway.json` (repo root) | Railway, on deploys of this existing service. Not applied by `railway up` on 2026-09-29. Railway has not said why. Stops being read **2026-12-01**. | builder, build, start, healthcheck, restart policy. It overrides the dashboard. |
| Service settings (dashboard, or `railway config apply`) | Every deploy of the service, whatever the source. **Empty today** for `shiftsync-api`, so everything currently depends on `railway.json`. | Same as above. |
| `railpack.json` (repo root, added 2026-10-02) | The Railpack builder, at build time. Ignored while the builder is NIXPACKS. | Build steps and the start command. **Not** the healthcheck or restart policy. |
| `package.json` `start` (added 2026-10-02) | Any builder that auto-detects (Railpack, Nixpacks) | Start command fallback (`npm run start` → `npm run server:start`) |
| `.railway/railway.ts` (draft, added 2026-10-02) | Only `railway config plan` / `railway config apply`, run by a person. **Railway never reads it during a deploy.** | Writes service settings. |

The healthcheck and restart policy are Railway deploy settings. They can only come from
`railway.json` or the service settings. A builder file can't provide them. A deploy whose
settings come from nowhere goes live without a healthcheck, which is what made the incident
possible.

What the two new repo files already guarantee (checked locally with Railpack v0.40.1, the
version used in the incident, using `railpack info` on a clean `git archive` of the repo):

| Repo state | Railpack's plan |
|---|---|
| master before 2026-10-02 | `↳ Deploying as vite static site`, start `caddy run …` (the incident) |
| + `start` script | `↳ Custom start command detected, skipping Caddy start`, build `npm run build`, start `npm run start` |
| + `railpack.json` | `↳ Using config file railpack.json`, install `npm install`, build `npx prisma generate`, start `npm run server:start` |

So even if every Railway setting is ignored, an auto-detected build now starts the API and
runs migrations. It still has **no healthcheck** until §3 is done.

## 1. Pre-flight (before every production API deploy)

1. **Source:** deploy from the GitHub source only. Pushes to `master` do not auto-deploy the
   API. Check that this is still true (service → Settings → Source) before relying on it.
2. **Variables** on `shiftsync-api` (names only, never paste values anywhere):

   | Variable | Required | Note |
   |---|---|---|
   | `DATABASE_URL` | yes | `server:start` runs `prisma migrate deploy` and the phone backfill against it on every boot |
   | `NODE_ENV` | yes, `production` | `server/src/lib/prisma.ts` only uses `DATABASE_URL` unchanged when `NODE_ENV=production`. Otherwise it runs `git rev-parse` and can add a `dev_<branch>` schema. Railpack sets it in the image (its plan shows `NODE_ENV=production`). Set it on the service anyway so it doesn't depend on the builder. |
   | `FRONTEND_ORIGIN` | yes | invite links are minted only for this origin |
   | `GEMINI_VERTEX_PROJECT`, `GOOGLE_SERVICE_ACCOUNT_JSON` | for voice / image roster parsing | Vertex AI, both features ([`vlm-go-live.md`](vlm-go-live.md)). `GEMINI_API_KEY` only without Vertex: one key per environment, the free tier is 20 requests/day per key. |
   | `ALLOW_DEV_OTP_ECHO` | demo only | shows real one-time codes on screen. Remove it after the demo. |
   | `ECHO_ALLOWED_PHONES` | whenever `ALLOW_DEV_OTP_ECHO=true` | from the parallel echo-allowlist change. Once that change is deployed, a production API with echo on and no allowlist **refuses to boot**, and the deploy fails its healthcheck. |
   | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | optional | push is off without them. Generate them with `npm run vapid:generate`, which prints to your terminal only. `VAPID_SUBJECT` must start with `mailto:` or `https:`. A bad value now turns push off (`[push] VAPID config rejected …` in the log) instead of crashing the API. |
   | `PORT` | injected by Railway | the healthcheck uses it too |

   Variable edits are staged on Railway. Deploying the staged changes is itself a redeploy,
   with the same volume outage as any other deploy.
3. **Migrations:** list the new folders in `prisma/migrations/` since the last deploy. They
   run at boot, before the healthcheck, and Railway's rollback does not undo them. Only
   additive migrations are allowed.
4. **Timing:** the API has a volume at `/app/server/uploads`. Railway never runs two
   deployments that mount the same volume, so **every deploy has about 3 minutes of
   downtime**, even with a healthcheck. Deploy outside venue service hours.
5. **Rollback target:** note the ID of the deployment currently serving (Deployments tab).

## 2. Production deploy (the procedure until #52 is closed)

1. Merge to `master` (Vercel ships the frontend on its own). When the frontend needs a new
   API, deploy the API first and merge the frontend after it.
2. Deploy the latest `master` commit from the **GitHub source**: dashboard, or
   `railway redeploy --from-source` as used in #52. The current
   [`railway redeploy` docs](https://docs.railway.com/cli/redeploy) list only
   `--service`/`--yes`/`--json` and say it redeploys the *most recent deployment without new
   code*. Run `railway redeploy --help` on your CLI version and confirm that `--from-source`
   still exists before you use it.
3. **Build log.** It must show (with `railway.json`, today):
   - `nixpacks` as the build driver, with our build command
     `npm install --no-audit --no-fund && npx prisma generate`
   - start command `npm run server:start`

   After the §3 migration to Railpack it must show `Using config file railpack.json`,
   `Custom start command detected, skipping Caddy start`, build `npx prisma generate` and
   deploy `npm run server:start`.

   **If you ever see `Deploying as vite static site`, a start command of `caddy run …`, or no
   start command, cancel the deployment before it goes live, or roll back (§4) at once.**
   A `caddy` *setup* row in the Nixpacks plan (`pkgs: caddy`, `cmds: caddy fmt …`) is normal:
   it appears on every healthy build. Only the **start** row matters, and it must say
   `npm run server:start`.
4. **Deploy log:** `prisma migrate deploy` output, then the `[phone-e164] …` line, then
   `ShiftSync API listening on …`. If VAPID is set, `[push] … disabled` must not appear.
5. **Check it is the API, not a static site:**
   ```
   curl -si https://<railway-domain>/api/health                       → 200, content-type application/json, {"ok":true}
   curl -si https://shift-sync-shift-sync1.vercel.app/api/health      → same, through the Vercel rewrite
   curl -s  https://shift-sync-shift-sync1.vercel.app/api/push/vapid-public-key   → JSON, not <!doctype html>
   ```
   A `text/html` answer from any `/api/*` path is the incident's signature. Roll back.

## 3. Proving the successor config (closes #52, non-production first)

Done-when list from #52: both `railway up` and a GitHub-source deploy start the API, run
migrations and pass `/api/health`. The build log shows our commands. A deliberately broken
start fails the healthcheck and keeps the previous deploy serving.

### 3.1 Make a non-production environment

1. Project → Environments → New → **Duplicate** `production` and name it `deploy-check`.
   Duplicating copies services, variables and configuration
   ([docs](https://docs.railway.com/environments)).
2. **Before anything deploys there**, check its variables:
   - `DATABASE_URL` must resolve to **deploy-check's own Postgres**. A
     `${{Postgres.DATABASE_URL}}` reference resolves per environment. A literal URL would be
     production's, and the next boot would run migrations and the phone backfill against
     production.
   - Remove `ALLOW_DEV_OTP_ECHO` (or pair it with `ECHO_ALLOWED_PHONES`). Use a separate
     `GEMINI_API_KEY` or none, and a separate VAPID pair (`npm run vapid:generate`) or none.
3. Give its `shiftsync-api` a volume at `/app/server/uploads`, as in production. Volume
   behaviour changes how deploys switch over, so the test is only valid with one.
4. Point deploy-check's `shiftsync-api` source at a test branch, not `master` (see 3.3).

### 3.2 `railway up` with today's repo (start script + railpack.json)

From a clean checkout of `master` (after this PR is merged):

```
railway link                     # pick the project, environment deploy-check, service shiftsync-api
railway status                   # MUST say environment deploy-check. Stop if it says production.
railway up --ci --environment deploy-check --service shiftsync-api
```

Always pass `--environment`/`--service` explicitly, so a stale link can never target
production. Expected result: Railpack, `Using config file railpack.json`, build
`npx prisma generate`, start `npm run server:start`, migrations run, the API answers. If
the service settings are still empty, **no healthcheck runs** in this path. That gap is
what 3.3 closes.

### 3.3 Move the settings into the service (Infrastructure as Code)

`.railway/railway.ts` is the reviewed draft. It mirrors `railway.json`, except that it
switches the builder to **RAILPACK**, because Nixpacks is deprecated and Railpack is
Railway's default. `railway up` already used Railpack, and `railpack.json` drives it. The
build is `npx prisma generate` because Railpack's own install step already runs
`npm install`. It is a named partial (`shiftsync-api`), so an apply only touches that
service. If you would rather change one thing at a time, set `builder: "NIXPACKS"` and
`buildCommand: "npm install --no-audit --no-fund && npx prisma generate"` for the first
apply, and switch to Railpack later.

1. Use Railway CLI ≥ 5.42.1. The SDK requires it, and #52 used 5.63.
2. On a test branch, delete `railway.json`. Railway refuses to plan a service that
   `railway.json` still manages ("a service cannot be managed by both systems"). The
   deletion goes on a branch because `master` still feeds production.
3. `npm install --no-save railway@3.12.0` (the SDK version the draft was typechecked
   against. `--no-save` keeps it out of `package.json`.)
4. `railway link` to **deploy-check**, then `railway status` (must say deploy-check), then
   `railway config plan`.
   - **Apply only if** the plan lists nothing but `service.shiftsync-api` build/deploy fields:
     builder, buildCommand, startCommand, healthcheckPath, healthcheckTimeout,
     restartPolicyType, restartPolicyMaxRetries.
   - **Stop** if it lists any deletion or detach (variables, the volume, the service source,
     domains) or any other service. The draft declares no `env`, `volumeMounts` or `source`.
     Railway's docs don't say whether the engine leaves undeclared fields alone, so the plan
     output is the only authority.
   - If the plan says the service is still managed by Config as Code, the service may still
     have a Railway Config File path set. Clear it in service Settings and plan again. (Or use
     `railway config migrate`, which previews without `--apply`. With `--apply` it "writes the
     file and clears Railway Config File settings". It refuses to overwrite our draft unless
     you pass `--force`. Diff its output against the draft and don't keep both.)
5. `railway config apply`, interactively. Never use `--yes --confirm-destructive`.
6. Service → Settings now shows: builder Railpack, build `npx prisma generate`, start
   `npm run server:start`, healthcheck `/api/health` with a 120 s timeout, restart On Failure
   with 5 retries.

### 3.4 Check the #52 "Done when" list on deploy-check

- [ ] **GitHub-source deploy** of the test branch (no `railway.json`): build log as in §2.3
  (Railpack variant), migrations ran, `/api/health` passed, curl checks from §2.5 pass.
- [ ] **`railway up`** from a clean checkout of the same branch (commands as in 3.2): same
  result, **and** the deploy now waits for the healthcheck.
- [ ] **Broken start:** in deploy-check only, set the start command to `sleep 600` (it never
  listens) and deploy. Expect the healthcheck to fail after 120 s and the deploy to be marked
  failed. Then answer this question, which Railway's docs do not: **with the volume attached,
  is the previous deployment still serving?** Railway never runs two deployments on the same
  volume, so it may stop the old one first. Write the answer into #52. If the old deployment
  does not come back, a bad production deploy means an outage until someone rolls back (§4),
  and the timing rule in §1.4 matters even more.
- [ ] Restore the settings with `railway config plan`. It should show the start-command drift
  back to `npm run server:start`. Then `railway config apply`, deploy, and confirm it is
  healthy.

### 3.5 Production cutover (only after every 3.4 box is ticked)

1. Merge the `railway.json` deletion to `master`. Merging does not deploy the API. Check
   that no deployment started.
2. `railway link` to **production**, then `railway status`, then `railway config plan`. Same
   review rules as 3.3. Then `railway config apply`.
3. Check the service settings in the dashboard, then do a normal production deploy (§2).
   Watch for the Railpack lines.
4. Run one `railway up` against production only if you need to prove that path on
   production too. Then update `docs/deployment.md`, remove the "never `railway up`"
   warning (here and there) and close #52.

**Do all of this before 2026-12-01.** After that date `railway.json` is ignored, and an
empty service falls back to auto-detection: it starts thanks to `start`/`railpack.json`,
but with no healthcheck.

## 4. Rollback

- **Bad deploy:** Deployments → a previous green deployment → ⋯ → **Rollback**. That
  restores the Docker image and the variables
  ([docs](https://docs.railway.com/deployments/deployment-actions#rollback)). The volume
  outage still applies.
- **Migrations are not rolled back.** `prisma migrate deploy` only moves forward. The
  additive-only migration rule is what lets the previous image run on the newer schema.
- **Bad service settings after an IaC apply:** fix `.railway/railway.ts`, then
  `railway config plan` and `apply`. Until 2026-12-01 you can also restore `railway.json`
  (revert its deletion and redeploy), because a config file overrides dashboard values.
- **A `railway up` that went live as a static site:** roll back to the previous deployment,
  as on 2026-09-29.

## 5. What Railway's docs actually say (checked 2026-10-02)

- Config as Code is deprecated. For existing services it is "still read from your service
  repository during deploy" until the **2026-12-01 hard cutoff**, and new services cannot opt
  in. <https://docs.railway.com/infrastructure-as-code#iac-vs-config-as-code>,
  <https://docs.railway.com/config-as-code/reference>
- Infrastructure as Code "is evaluated by the Railway CLI", and "Railway doesn't read
  `.railway/` during deploys". It writes service settings through
  `railway config plan`/`apply`. A service can't be managed by both systems.
  <https://docs.railway.com/infrastructure-as-code>
- `railway config migrate` converts `railway.json`. `--apply` writes the file and clears the
  Railway Config File setting. A single-service migrate emits a named partial.
  <https://docs.railway.com/cli/config#migrate-config-as-code>
- The documented IaC `service()` fields are `build`, `start`, `healthcheck`,
  `healthcheckTimeout`, `preDeploy`, `replicas`, `env`, `domains` and `volumeMounts`.
  Builder and restart policy are **not documented**, but the SDK's types accept them
  (`railway@3.12.0`: `build.builder`, `deploy.restartPolicyType`/`restartPolicyMaxRetries`),
  and the draft typechecks and compiles against it.
  <https://docs.railway.com/infrastructure-as-code/reference>
- Builder: "`RAILPACK` (default)", `DOCKERFILE`. Nixpacks is deprecated.
  <https://docs.railway.com/config-as-code/reference#specify-the-builder>,
  <https://blog.railway.com/p/introducing-railpack>
- Railpack serves a Vite build as a static site unless `RAILPACK_NO_SPA` is set or there is
  a custom start command. Its source counts a non-default `package.json` `start` script as
  one (`hasCustomStartCommand` in `core/providers/node/spa.go`). It reads `railpack.json`,
  and `RAILPACK_BUILD_CMD`/`RAILPACK_START_CMD` also work.
  <https://railpack.com/languages/node#static-sites>, <https://railpack.com/config/file>,
  <https://railpack.com/config/environment-variables>
- Healthchecks run only at deploy time. The default timeout is 300 s. With a volume
  attached "there will be a small amount of downtime … even if there is a healthcheck".
  <https://docs.railway.com/deployments/healthchecks>
- The default restart policy is On Failure with 10 retries. We use 5.
  <https://docs.railway.com/deployments/restart-policy>

**Not answered by the docs (verify in §3, don't assume):**
1. Why `railway up` skipped `railway.json`. The [`railway up` docs](https://docs.railway.com/cli/up)
   don't mention config files.
2. Whether a failed healthcheck keeps the previous deployment serving when a volume forces
   the old one to stop first.
3. Whether `railway config apply` leaves undeclared variables, volume mounts and source
   untouched.
4. Whether `railway config migrate` without `--apply` talks to Railway. The docs say "linked
   services … keep their Railway service names", which suggests it reads the linked project.
5. `railway redeploy --from-source` is used in #52 but is not in the current docs.
