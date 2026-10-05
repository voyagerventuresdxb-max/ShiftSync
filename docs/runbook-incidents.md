# Incident runbook

What to do when production breaks: roll back, fix migrations forward, find out why sign-in or a
health check fails, switch AI off, revoke links, and lock out a compromised account. Written
2026-10-04 from the code and docs on `master`. Nothing here was run against production.

Words used below:

- **The owner**: the person who runs ShiftSync's accounts (Railway, Vercel, Google Cloud).
- **A venue owner**: a person with the OWNER role inside one venue in the app.

Standing rules:

- **Never run `railway up` against production** (#52). Deploy from the GitHub source only
  ([`railway-deploy-procedure.md`](railway-deploy-procedure.md) §2).
- Never paste a key, token, phone number or log line with personal details into chat, an issue
  or a PR. Names of variables are fine. Values are not.
- Anything that changes the production database by hand is the owner's decision, and is done by
  a person with database access. This runbook gives no SQL.

## 0. First five minutes

1. Check both health endpoints, on the Railway domain and through Vercel:
   ```
   curl -si https://<railway-domain>/api/health
   curl -si https://<railway-domain>/api/health/ready
   curl -si https://shift-sync-shift-sync1.vercel.app/api/health
   ```
   `/api/health` must answer `200`, `content-type: application/json`, `{"ok":true}`.
   `/api/health/ready` must answer `200` with `"pending":0` (see §2).
2. In Railway → `shiftsync-api` → **Deployments**, write down the ID of the deployment that is
   serving now, and the one before it. You need them to roll back.
3. Write down the time, and any `X-Request-Id` a user or `curl` gave you (§3.3).
4. Decide: roll back now (§1), or fix forward (§2). If users can't work, roll back first.

## 1. Roll back

### 1.1 API on Railway

1. Railway dashboard → `shiftsync-api` → **Deployments** → the last good deployment before the
   bad one → **⋯** → **Rollback** ([`railway-deploy-procedure.md`](railway-deploy-procedure.md) §4,
   [`deployment.md`](deployment.md) "Rollback").
2. Use the dashboard. The pinned Railway CLI (5.63.1) has no "roll back to this deployment"
   command ([`AUTONOMOUS_RUN.md`](AUTONOMOUS_RUN.md), run log rollback note). **Never use
   `railway up` to "go back".** On 2026-09-29 it replaced the API with the frontend (#52).
3. Expect about **3 minutes of downtime**. The API has a volume at `/app/server/uploads`, and
   Railway never runs two deployments on the same volume (procedure §1.4).
4. A rollback restores the old image **and the old variables**. If you changed a variable after
   that deployment (for example, you switched AI off in §5), the rollback brings the old value
   back. Check the variables after every rollback.
5. **Migrations are not rolled back** (§2). The previous image runs on the newer schema because
   migrations are additive.
6. Check it worked: `/api/health` is JSON, not `text/html`, and `/api/health/ready` is `200`.

Unknown, still open in #52 (procedure §3.4): whether a deploy that fails its healthcheck keeps
the previous deployment serving while the volume is attached. Assume it may not, and roll back
by hand.

### 1.2 Frontend on Vercel

1. Vercel dashboard → the project → **Deployments** → an earlier production deployment →
   **Promote to Production** ([`deployment.md`](deployment.md) "Rollback").
2. Or push a revert commit to `master`. Vercel builds and ships it.
3. The frontend and the API roll back separately. The only link between them is the `/api`
   rewrite in `vercel.json`.
4. The deploy rule is "API first, then the frontend that needs it" (procedure §2.1). So if you
   roll the API back past a change the current frontend needs, roll the frontend back too.

## 2. Migrations: fix forward only

- Migrations live in `prisma/migrations/`. **Only additive migrations are allowed**
  (procedure §1.3).
- They run on every boot, before the healthcheck: `server:start` is
  `prisma migrate deploy`, then the phone backfill, then the API.
- A bad migration is fixed with a **new** migration, merged to `master` and deployed the normal
  way. **Never edit or delete a migration folder that production has applied.**
- If a migration fails at boot, the start command stops before the API listens, so the deploy
  fails its healthcheck. Read the `prisma migrate deploy` output in the deploy log. Repairing the
  database after a failed migration needs a person with database access and is the owner's
  decision.

What `/api/health/ready` reports (`server/src/lib/readiness.ts`). It shows counts only, never
migration names:

| Answer | Meaning | What to do |
|---|---|---|
| `200`, `"db":"ok"`, `"pending":0` | The database answers, and every migration folder in this build is applied. | Nothing. After a rollback to an older build, `applied` can be larger than `expected`. That is normal. |
| `503`, `"db":"ok"`, `"pending"` above 0 | This build has migrations the database does not have. | Read the deploy log for the `prisma migrate deploy` output. |
| `503`, `"db":"unreachable"`, `"migrations":null` | The database did not answer within 3 seconds. | Look for `[health.ready] database check failed: …` in the log. Check the Railway Postgres service and `DATABASE_URL`. |

`/api/health` never touches the database. It can be `200` while `/api/health/ready` is `503`.

## 3. When a health check fails

### 3.1 `/api/health` fails, or answers HTML

- An HTML answer (`<!doctype html>`, `text/html`) from any `/api/*` path is the #52 signature:
  the frontend is running where the API should be. **Roll back** (§1.1).
- In the **build log**, `Deploying as vite static site`, `caddy`, or no start command means the
  same thing. Cancel the deployment or roll back (procedure §2.3).
- In the **deploy log**, a healthy boot shows, in this order: the `prisma migrate deploy`
  output, a `[phone-e164] …` line, then `ShiftSync API listening on …` (procedure §2.4).
- `[startup] Refusing to start in production …` means the API stopped itself on purpose. The
  line names every setting at fault. Fix or remove each named variable, then deploy again. The
  rules are in [`ENV_VARS.md`](ENV_VARS.md) §5, and the full must-be-set / must-be-absent list is
  in §6.
- These lines do **not** stop the API: `[push] … push notifications are disabled` (push is off,
  see [`push-go-live.md`](push-go-live.md) §4) and `[startup]` warnings about
  `ECHO_ALLOWED_PHONES` entries.

### 3.2 `/api/health/ready` fails

See the table in §2.

### 3.3 Find the log lines for one request

1. Every API response carries an `X-Request-Id` header. Get it from the browser's developer
   tools (Network tab → the request → response headers), or from `curl -si`.
2. Every log line written for that request starts with `[rid=` and the **first 8 characters**
   of that id ([`ENV_VARS.md`](ENV_VARS.md) §4b).
3. Search the Railway deploy logs for `rid=<first 8 characters>`.
4. Phone numbers are masked in all server logs. Still, don't copy log lines into public places.

## 4. When sign-in fails

| What the person sees | What it means | What to do |
|---|---|---|
| "No account with that number." | No account has that phone number. | Check the number in People → Staff Directory. New staff join with the venue's join link. |
| No code arrives | Codes are texted only when SMS sign-in is switched on (#51, [`otp-delivery-uae.md`](otp-delivery-uae.md)). | A manager sends a login link: People → Staff Directory → **Send login link**. |
| "Too many code requests for this number — try again in …" or "Too many requests — please wait a few minutes and try again." | A rate limit. | Wait, then try again. |
| "Too many incorrect attempts — request a new code." | Wrong code entered too often. | Request a new code. |
| "This link has already been used or has expired — ask your manager for a new one." | The login link was used, expired, replaced by a newer one, revoked, or the person is inactive. | Send a new link. The API log has `[loginLinks.redeem] refused (<reason>)` with the real reason. |
| Only a "paste your login link" box, no phone field | `LOGIN_METHODS=links` is set on the API. | [`ENV_VARS.md`](ENV_VARS.md) says to leave it unset. Remove it and deploy, if that was not intended. |
| "Waiting for <name> to approve you at <venue>." | A join request is pending. | A manager approves it in People → **Pending Approvals**. |
| "Your staff account at <venue> has been deactivated. Ask a manager there to reactivate it." | The person is inactive. | A manager or venue owner sets them Active in the Staff Directory (§6.5 says who may). |
| "You've been signed out. Sign in again to continue." | The session ended: deactivation, sign-out, or 30 days passed. | Sign in again. |
| "We couldn't text you a code just now. Please try again in a minute." with `OTP SMS not sent: …` in the log | SMS is on and the provider refused the send. | Check the provider settings ([`ENV_VARS.md`](ENV_VARS.md) §6, SMS rows). |
| A login link opens the wrong website | Links use the **first** entry of `FRONTEND_ORIGIN`. | Fix `FRONTEND_ORIGIN` and deploy. |
| Nobody can sign in | Usually the API is down or `/api` doesn't reach it. | Start at §0. |

## 5. Switch AI off quickly

AI covers roster photos and scans (vision) and voice commands. Spreadsheets, text PDFs, manual
entry and the app's buttons keep working with AI off.

| Action (Railway → `shiftsync-api` → Variables) | Effect | When it starts |
|---|---|---|
| Set `AI_MONTHLY_BUDGET_USD=0` | Every Gemini / Vertex call is refused before anything is sent (`server/src/lib/aiBudget.ts`). Roster upload shows "AI reading is paused for this month; upload Excel/CSV or add staff manually." Voice shows "Voice commands are paused for the rest of this month (AI spending limit reached). Use the app's buttons meanwhile." | After the next deploy |
| Set `AI_DAILY_CALL_LIMIT=0` | Same refusal for every feature, by call count ("…today's limit…"). | After the next deploy |
| Set `AI_VOICE_DAILY_CALL_LIMIT=0` (or `AI_VISION_DAILY_CALL_LIMIT=0`) | Only voice (or only photo reading) is refused; the other keeps working. | After the next deploy |
| Delete `GEMINI_VERTEX_PROJECT` and `GOOGLE_SERVICE_ACCOUNT_JSON` | Photo and scan reading **and voice** are off (unless a `GEMINI_API_KEY` is also set): "AI roster reading isn't set up on this server. Upload an Excel/CSV export instead." and "Voice commands aren't set up on this server yet." ([`vlm-go-live.md`](vlm-go-live.md) §7) | After the next deploy |
| Delete `GEMINI_API_KEY` | Only matters without Vertex: vision and voice were using this key. | After the next deploy |
| Disable or delete the key in Google Cloud | Google refuses the calls. Users see the app's "not available" messages. | At once, no deploy. Then remove the variable on the next deploy. |

How variables take effect:

- Railway **stages** variable edits. Nothing changes until you deploy the staged change. That
  deploy is a redeploy, with about 3 minutes of downtime (procedure §1.2, §1.4).
- A rollback (§1.1) restores the old variables. After a rollback, check the AI variables again.
- The cap's current state: `GET /api/ai/usage` (venue owner only; there is no screen for it).
  The log shows `[ai-budget] WARNING … 80% …` once a month near the cap. A line
  `[ai-budget] spend ledger unreachable` means AI calls are being refused because the database
  can't be reached.

## 6. Revoke access

### 6.1 Join (invite) links

A manager or venue owner, for their own venue: People → **Join link**.

- **Revoke** → **Yes, revoke**. The link stops working at once. Nobody can join until a new link
  is generated.
- **Regenerate** → **Create new link**. The old link stops working as soon as the new one exists.
- A join link only files a request. A manager still approves each person. Decline any request in
  Pending Approvals that you don't recognise.

### 6.2 Login links

- One person has at most one live link. Sending a new one (People → Staff Directory → **Send
  login link**, or **New link** after the first) ends the older unused link.
- Who may send a link: a manager to staff at their venue; a venue owner to managers and staff in
  their organization; a platform admin to venue owners and managers.
- Links expire after `LOGIN_LINK_TTL_HOURS` (default 24 hours).
- Deactivating the person (§6.5) ends every unused link and every session they have.
- The app has no "revoke this link" button today. The API can revoke one link, for anyone who
  could issue it.
- A link that was already used has started a session. Revoking links does not end that session.
  Deactivate the person to end it.

### 6.3 Kiosk links

A venue's shared screen opens a kiosk link (`/kiosk?venue=…#k=…`). Owners and managers of that
venue manage it on People → **Kiosk link** ([`deployment.md`](deployment.md) → Kiosk links):

- **Revoke**: no kiosk link works for the venue; open shared screens show "Kiosk link needed".
- **Regenerate**: the old link stops working at once; the new one is shown once, to copy to the
  screen.
- A leaked kiosk link shows only the published rota (names, roles, times), announcements and
  shoutouts. It can't change anything or open any other page.
- Kiosk regenerate and revoke are not in the audit log yet.

### 6.4 Sessions

- Profile → **Sign out** ends the session on that device only.
- There is no "sign out everywhere" button for your own account.
- Deactivation (§6.5) and account deletion end **all** of a person's sessions.
- Sessions last 30 days.

### 6.5 Deactivate a person

People → Staff Directory → set the person to **Inactive**. This signs them out everywhere at once
and ends their unused login links. Setting them **Active** again also clears old sessions, so they
sign in fresh (`server/src/routes/staffDirectory.ts`, `server/src/lib/identity.ts`).

| Who | May set Active / Inactive for |
|---|---|
| Manager | Staff only |
| Venue owner | Managers and staff |
| Anyone | Never their own account |
| Nobody | Another venue owner, or a venue's last active owner |

## 7. A compromised venue owner account

**The app has no way to deactivate a venue owner.** Managers can change staff only. Venue owners
can change managers and staff, not other owners. Nobody can change their own status. The server
also refuses, inside the same write, to deactivate a venue's last active owner
(`server/src/lib/actions/employmentStatusActions.ts`). The app also has **no screen to make
someone an owner**.

Options the repo supports:

1. **The real venue owner signs out** on their own devices (Profile → Sign out). This ends only
   those sessions.
2. **The real venue owner deletes their own account**: Profile → **Delete my account…** →
   **Yes, delete my account**. This ends every session and every unused login link at once. It is
   immediate and can't be undone. Their personal details are removed. Shifts stay, without
   their name. It is **refused if they are the venue's last active owner**. That refusal message
   suggests making another manager an owner first, but the app has no screen for that today.
   After deletion, the app cannot make that person an owner of this venue again.
3. **Contain the damage** while you decide: a manager or the other venue owner regenerates the
   join link (§6.1), declines unknown join requests, and checks the Staff Directory for status
   changes they didn't make.
4. **Anything else is a manual database step**: deactivating the owner account, ending its
   sessions, or moving the owner role. That is the owner's decision, and must be done by a person
   with database access. The venue must keep at least one active venue owner, because the app
   assumes it always has one.

Afterwards: the audit log records login links issued, used, refused and revoked, staff status
changes, join decisions and join-link changes. There is no audit screen in the app; reading it
needs database access.
