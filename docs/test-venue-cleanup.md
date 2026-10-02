# Test-venue cleanup

`server/scripts/cleanup-test-venues.ts` (`npm run cleanup:test-venues`) finds organizations
created by e2e runs, server tests and deploy checks, and deletes each one with everything
that hangs off it, including its uploaded files. Written for issue #53. The logic and its
tests are in `server/src/lib/testVenueCleanup.ts`.

- **It's a dry run by default.** Without `--confirm` it prints what it would delete (each
  org, its locations and users, row counts per table, file paths) and changes nothing.
- **It only runs on localhost.** If `DATABASE_URL`'s host isn't `localhost` or `127.0.0.1`,
  it exits with code 2 before it builds a database client, so no query runs. The one way
  past this check is `--i-am-running-against-production=<host>` (see
  [Production](#production-issue-53)).

## What it matches

An organization matches only if its name **starts with** one of these prefixes. The match is
exact and case-sensitive, never a substring or a fuzzy match:

| Prefix | Created by |
|---|---|
| `__e2e-test__` | `e2e/helpers.ts` `TEST_ORG_PREFIX` (every Playwright venue) |
| `__deploy-check__` | production deploy verification (#49, #53) |
| `__admin-actions-test__` | `server/src/lib/actions/adminActions.test.ts` (`createOrgShell`) |
| `__login-links-test__` | `server/src/routes/loginLinks.test.ts` |
| `__task-signup-test__` | `server/src/routes/signup.test.ts` (`POST /api/signup`) |

The database filters with `startsWith`, but `_` is a SQL `LIKE` wildcard, so every name is
checked again in JS with a plain string prefix check. A name such as `ZZe2e-test__ …` never
matches.

`--name "<exact org name>"` narrows the run to the org with exactly that name. The name must
still start with one of the prefixes above; otherwise the script refuses.

Server tests also use other `__…-test__` tags, such as `__dev-otp-echo-test__`,
`__invite-links-test__` and `__join-approval-test__`. Those name locations and users inside
the seed org, never an organization, so they aren't in the list. The script never deletes a
location from an org that doesn't match.

## What it deletes

Each org is deleted in **its own transaction**:

1. The org's shifts. `shifts.role_id` is `ON DELETE RESTRICT`, so deleting them first means
   the cascade never depends on trigger order.
2. The organization row. Schema cascades then remove its locations, and with them every
   location-scoped table and every user at those locations, plus each user's own rows
   (sessions, login links, notifications, availability, attendance, …). The dry run prints
   the count for every table it touches.
3. The `otp_codes` rows for those users' phones, matching both the stored form and its E.164
   form. Phones are global, so a phone is skipped if a surviving user holds it (as `phone` or
   `phone_before_e164`) or if another venue has a join request from it.

If the org was renamed or removed between the plan and the delete, the transaction rolls
back.

**Files** are the `file_url`s of the org's `floor_plan_images` and `policy_documents`,
mapped to `<uploads>/floor-plans/<file>` and `<uploads>/policy-documents/<file>`. A
`file_url` with any other shape, or one that would resolve outside the uploads dir, is
listed and left alone. Files are deleted only after that org's transaction commits; a file
that's already gone is reported as `already missing`. The uploads dir is `server/uploads`
next to the script, which is `/app/server/uploads` (the uploads volume) on Railway.

**Blocked orgs:** if any of the org's users has rows in **another** venue that the user
cascade would also delete (swap requests, attendance logs, voice logs, section assignments,
shoutouts, floor feedback), the org is listed as `BLOCKED` and skipped, even with
`--confirm`.

After deleting, the script prints `rows before -> after` for each org; every `after` should
be 0. Phones are printed redacted (`+971*******67`), and the database URL is never printed.

Exit codes: `0` done; `1` an org wasn't deleted or a file couldn't be removed; `2` refused
(bad flag, non-test `--name`, or a non-local host).

## Local use

```sh
npm run cleanup:test-venues                 # dry run against this branch's schema
npm run cleanup:test-venues -- --confirm    # delete what the dry run listed
```

The npm script goes through `scripts/with-branch-schema.mjs`, which joins its arguments
back into one string, so a `--name` containing spaces gets split. Quote the whole command
instead:

```sh
node scripts/with-branch-schema.mjs "npx tsx server/scripts/cleanup-test-venues.ts --name '__e2e-test__ golden-path 1759400000000'"
```

## Production (issue #53)

This is for the human to run. Agents never point this script at production.

The leftover from #53:

- Organization `__deploy-check__ floor plan 2026-09-30`, with one location and one manager
  user (created through the normal signup flow).
- One or more `floor_plan_images` rows for that location. The first row's file was lost in
  the 2026-09-29 redeploys, before the API had an uploads volume, so the dry run should show
  it as `already missing on disk`. Later verification uploads may have added files under
  `/app/server/uploads/floor-plans/`.
- Its sections and assignments were already deleted through the API on 2026-10-01.

### Before you start

- **The production database is reachable only on Railway's private network**, so the script
  has to run inside the `shiftsync-api` container, which has `DATABASE_URL` and the uploads
  volume. You can't run it from your laptop.
- **`railway ssh` needs an SSH key registered on the Railway account** (a one-time step in
  the Railway account settings). Then link the project and open a shell in the
  `shiftsync-api` service with `railway ssh`. The flags vary by CLI version, so check
  `railway ssh --help`.
- **The script has to be deployed.** It reaches Railway only after this PR is merged to
  `master` and the API has redeployed. Check that `/app/server/scripts/cleanup-test-venues.ts`
  exists in the container.
- **The delete is permanent.** If you want a safety net, take a Postgres backup first.
- **Don't use `npm run cleanup:test-venues` in production.** It goes through
  `with-branch-schema.mjs`, which would point it at a `dev_<branch>` schema. Run `tsx`
  directly, as below.

### Steps (inside `railway ssh`, in `/app`)

1. Get the database host the override flag has to name:

   ```sh
   node -e "console.log(new URL(process.env.DATABASE_URL).hostname)"
   ```

   Use the hostname only, without the port. It's typically `postgres.railway.internal`.

2. Dry run:

   ```sh
   npx tsx server/scripts/cleanup-test-venues.ts --name "__deploy-check__ floor plan 2026-09-30" --i-am-running-against-production=<host from step 1>
   ```

   Check the output before going on:
   - exactly **1** organization, with **1** location and **1** user (the manager);
   - the row counts (expect `floor_plan_images` ≥ 1, `floor_sections` 0,
     `section_assignments` 0, plus that manager's `sessions` and `otp_codes`);
   - the `file` lines under `/app/server/uploads/floor-plans/`;
   - no `BLOCKED` line.

   Optionally, run it once without `--name` to list every test-prefixed org in production.
   Only this one is expected, because e2e runs and server tests never touch production.

3. Delete. Run the same command with `--confirm` added:

   ```sh
   npx tsx server/scripts/cleanup-test-venues.ts --name "__deploy-check__ floor plan 2026-09-30" --i-am-running-against-production=<host from step 1> --confirm
   ```

   The result should read `DELETED`, every `rows before -> after` entry should end in `0`,
   and each file should say `deleted` or `already missing`. Exit code 0.

4. Leave the shell. Nothing needs restarting.
