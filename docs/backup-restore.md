# Backups and restore

Which data ShiftSync keeps in production, the questions the owner must answer about its backups,
and a plan for a first restore test. Written 2026-10-04 from the docs and code on `master`.

**The repo says nothing about how production is backed up.** This file does not answer the
questions in §3. The owner answers them from the providers' dashboards. Nothing here was checked
against the live services.

## 1. Which database production uses

What the repo says:

- Production uses a **Railway Postgres** service in the Railway project, not Supabase
  ([`deployment.md`](deployment.md) "Which database" and setup step 1.2).
- The API's `DATABASE_URL` should be the Railway reference `${{Postgres.DATABASE_URL}}`, not a
  literal URL ([`ENV_VARS.md`](ENV_VARS.md) §6).
- The database is reachable only on Railway's private network, from inside the
  `shiftsync-api` service ([`test-venue-cleanup.md`](test-venue-cleanup.md),
  [`vlm-go-live.md`](vlm-go-live.md) §5).

The brief for this file called the production database "Supabase". **The repo disagrees.** In the
repo, Supabase is:

- the **staging** database, a separate Supabase project ([`staging-setup.md`](staging-setup.md) §1);
- the **old shared development database**, which [`deployment.md`](deployment.md) says not to
  use for production.

The repo cannot prove what the live variable holds. Confirm in Railway → `shiftsync-api` →
Variables that `DATABASE_URL` is the Postgres reference. Look at the name only; don't copy the
value anywhere.

## 2. Where production data lives

| What | Where | In a database backup? |
|---|---|---|
| Venues, people, shifts, availability, swaps, announcements, shoutouts, sessions, login and invite links, notifications, audit log, AI spend counters | The Railway Postgres database (one database for every venue) | Yes, if backups are on |
| Floor-plan images and policy documents | The API's volume at `/app/server/uploads` ([`deployment.md`](deployment.md) setup step 1.4) | **No.** The volume needs its own backup. |
| Roster-upload previews | A 15-minute cache file (`UPLOAD_CACHE_FILE`) outside the volume | No, and not needed. It is lost on every deploy by design. |
| Variable values (keys, credentials) | Railway service variables, Google Cloud | No |
| The web app | Vercel (a static build from `master`) | Not needed. It can be rebuilt from git. |

## 3. Questions for the owner

Answer each one in the provider's dashboard, then write the answer, the date and your name next
to it. Don't guess.

**Railway Postgres**

1. Are backups switched on for the production Postgres service?
2. How often is a backup taken?
3. How long is each backup kept?
4. Is point-in-time recovery available? If yes, how far back can you go?
5. How is a restore done: over the live database, or into a new service? Who can start one?
6. How long does a restore take for our database? How big is the database today?
7. Has a restore ever been tested? When, by whom, and with what result?
8. Who has access to the backups and to the restore button? Do they all use two-factor sign-in?
9. In which region are backups stored? Does that match what the privacy policy will say?
10. Are backups encrypted?
11. Who is told when a backup fails?
12. All venues share one database. Can one venue be restored without rolling back every other
    venue? If not, what is the plan when only one venue's data is damaged?

**Uploads volume (`/app/server/uploads`)**

13. Does Railway back up this volume? How often, and for how long?
14. If not, what copies the floor plans and policy documents, and where to?
15. Are volume backups and database backups taken at about the same time? A restored database
    can point at files that are missing from a restored volume, or the other way round.

**Everything else**

16. Where is a safe copy of the Railway variable values kept (for example a password manager),
    and who can get to it?
17. How much data can we afford to lose (hours)? How long can the service be down?
18. Deleted accounts stay inside old backups until those backups expire. How long is that, and
    does the privacy policy say so? (Counsel's question too: [`store-readiness.md`](store-readiness.md) §1–2.)
19. Does staging (Supabase) need backups, or is it disposable?

## 4. Facts to know before any restore

- On every boot the API runs `prisma migrate deploy`. A restored database that is older than the
  running code gets the missing migrations applied when the API starts.
  `/api/health/ready` shows `pending: 0` once they are all applied
  ([`runbook-incidents.md`](runbook-incidents.md) §2).
- Migrations are additive only, so an older API image can run on a newer schema.
- A restore brings back everything as it was at backup time:
  - **Account deletions and deactivations made after that time are undone.** Re-apply them by
    hand after the restore. Account deletion is a promise to the user, and the store rules
    depend on it ([`store-readiness.md`](store-readiness.md) §1).
  - Sessions and unused links from that time work again, until they expire.
  - The AI spend counters go back to their old values, so the month's cap counts from there.
- A restore into production means downtime. Each API deploy is about 3 minutes down because of
  the volume ([`railway-deploy-procedure.md`](railway-deploy-procedure.md) §1.4).
- Never run a `with-branch-schema.mjs` command (the `npm run` database scripts) against
  production or a restored copy. That wrapper points the command at a `dev_<branch>` schema,
  not at the restored data ([`test-venue-cleanup.md`](test-venue-cleanup.md),
  [`vlm-go-live.md`](vlm-go-live.md) §5).
- Before a risky manual change in production, take a backup first
  ([`test-venue-cleanup.md`](test-venue-cleanup.md)).

## 5. Restore test (a plan, not a fact)

**This is a plan. No restore test has been done.** The restore steps themselves depend on the
answers to §3.

### 5.1 Practise with demo data (no real data)

1. In your own worktree, on the local Docker database and your branch's own schema
   (AGENTS.md §6): `npm run db:setup`, then
   `npm run db:seed:demo -- --phones=<three test numbers you control>`.
2. Take a backup of that schema with the standard Postgres tools.
3. Restore it into a **separate** local database. Never restore into `public` or into another
   branch's schema.
4. Compare the two: row counts per table, and the number of applied rows in
   `_prisma_migrations` against the number of folders in `prisma/migrations/`.
5. Write down every step that was unclear. That becomes the real procedure.

### 5.2 Restore a real backup into a non-production environment

A real backup holds real names and phone numbers. Keep it inside the provider, with the same
access rules as production. Copying it to a laptop is the owner's decision.

1. **Make the target.** A Railway environment that is not production, with its **own** Postgres
   and its own volume at `/app/server/uploads`. [`railway-deploy-procedure.md`](railway-deploy-procedure.md)
   §3.1 shows how, and how to check that `DATABASE_URL` resolves to that environment's own
   database.
2. **Cut every path to real people before the first deploy.** Remove the VAPID keys (push), the
   SMS settings, the code-echo settings and the AI keys from that environment. Point
   `FRONTEND_ORIGIN` away from the production web address. The restored data contains real
   people, and nothing in the test may message them.
3. **Restore** the chosen production backup into that environment's Postgres, with the
   provider's own restore feature (answers to §3, questions 5–6). Restore the uploads backup
   into its volume, if one exists.
4. **Deploy** the same commit that production runs, from the GitHub source. Never `railway up`.
5. **Check:**
   - `/api/health` answers `{"ok":true}`.
   - `/api/health/ready` answers `200` with `pending: 0`.
   - Inside the service (`railway ssh`), with read-only checks: row counts for the main tables,
     the newest record's time (it should match the backup time), and that the files listed in
     the database exist on the volume.
6. **Record** the time from start to healthy, the age of the data, and every problem. These are
   the answers to §3, questions 6 and 7.
7. **Tear down** the environment, its database and its volume when the test is done.
