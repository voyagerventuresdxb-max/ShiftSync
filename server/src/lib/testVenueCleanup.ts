/**
 * Finds and deletes test venues (whole organizations) left behind by e2e runs,
 * server tests and deploy checks (#53). Used by server/scripts/cleanup-test-venues.ts;
 * see docs/test-venue-cleanup.md. Everything here is conservative by design: an
 * org matches only by an exact name prefix, and an org whose deletion would spill
 * into another venue's rows is reported and skipped, never deleted.
 */
import { stat, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { PrismaClient } from '@prisma/client';
import { toE164 } from './phone.js';

/** Org-name prefixes only test code and deploy checks use. Exact, case-sensitive prefix match. */
export const TEST_ORG_PREFIXES = [
  '__e2e-test__', // e2e/helpers.ts TEST_ORG_PREFIX
  '__deploy-check__', // production deploy verification (#49, #53)
  '__admin-actions-test__', // server/src/lib/actions/adminActions.test.ts (createOrgShell)
  '__login-links-test__', // server/src/routes/loginLinks.test.ts
  '__task-signup-test__', // server/src/routes/signup.test.ts (POST /api/signup)
] as const;

export function isTestOrgName(name: string): boolean {
  return TEST_ORG_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export const PRODUCTION_FLAG = 'i-am-running-against-production';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export type HostCheck = { ok: true; host: string; production: boolean } | { ok: false; reason: string };

/**
 * Localhost only, unless `productionHost` (the value of --i-am-running-against-production)
 * names DATABASE_URL's host exactly. Never prints the URL itself: it carries the password.
 */
export function checkDatabaseHost(databaseUrl: string | undefined, productionHost?: string): HostCheck {
  if (!databaseUrl) return { ok: false, reason: 'DATABASE_URL is not set.' };
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return { ok: false, reason: 'DATABASE_URL is not a valid URL.' };
  }
  // Prisma connects to a `?host=` query parameter instead of the URL's host, so the host below wouldn't be the real one.
  if (url.searchParams.has('host')) return { ok: false, reason: 'DATABASE_URL has a host= query parameter, which overrides its host; refusing.' };
  const host = url.hostname;
  if (productionHost !== undefined) {
    if (host !== '' && productionHost === host) return { ok: true, host, production: true };
    return { ok: false, reason: `--${PRODUCTION_FLAG}=${productionHost} does not match DATABASE_URL's host "${host}".` };
  }
  if (LOCAL_HOSTS.has(host)) return { ok: true, host, production: false };
  return {
    ok: false,
    reason: `DATABASE_URL's host is "${host}", not localhost or 127.0.0.1. This script only runs against a local database (see docs/test-venue-cleanup.md for the production procedure).`,
  };
}

export const USAGE = `Usage: tsx server/scripts/cleanup-test-venues.ts [--confirm] [--name "<exact org name>"] [--${PRODUCTION_FLAG}=<db host>]
  (no flags)  dry run: list what would be deleted, delete nothing
  --confirm   delete what the dry run lists
  --name      only the org with exactly this name (it must still start with a test prefix)
  --${PRODUCTION_FLAG}=<host>  allow a non-local DATABASE_URL whose host is exactly <host> (production cleanup only)
Test prefixes: ${TEST_ORG_PREFIXES.join(', ')}`;

export interface CliOptions {
  confirm: boolean;
  name?: string;
  productionHost?: string;
}

/** Throws (message = what's wrong) on anything but the flags above. */
export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: { confirm: { type: 'boolean', default: false }, name: { type: 'string' }, [PRODUCTION_FLAG]: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  const name = values.name as string | undefined;
  if (name !== undefined && !isTestOrgName(name)) {
    throw new Error(`--name "${name}" does not start with a test prefix; this script never deletes other organizations.`);
  }
  return { confirm: values.confirm as boolean, name, productionHost: values[PRODUCTION_FLAG] as string | undefined };
}

/** "+971501234567" -> "+971*******67". */
export function redactPhone(phone: string): string {
  const head = phone.length > 8 ? 4 : 0;
  return phone.slice(0, head) + phone.slice(head, -2).replace(/\d/g, '*') + phone.slice(-2);
}

/**
 * Disk path of an uploaded file's `fileUrl` (`/uploads/<floor-plans|policy-documents>/<file>`),
 * or null when it doesn't have that exact shape or would resolve outside `uploadsDir`.
 */
export function uploadFilePath(uploadsDir: string, fileUrl: string): string | null {
  const match = /^\/uploads\/(floor-plans|policy-documents)\/([^/\\]+)$/.exec(fileUrl);
  if (!match || match[2] === '.' || match[2] === '..') return null;
  const root = resolve(uploadsDir);
  const full = resolve(root, match[1]!, match[2]!);
  const rel = relative(root, full);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? full : null;
}

// Every table, scoped to what deleting the org (and so its locations and their users) removes.
// $1 location ids, $2 user ids, $3 org ids, $4 OTP phones — via the `s` CTE so each query binds all four.
const DELETED_ROWS: readonly (readonly [table: string, where: string])[] = [
  ['organizations', 'id = ANY(s.org)'],
  ['locations', 'id = ANY(s.loc)'],
  ['users', 'id = ANY(s.usr)'],
  ['roles', 'location_id = ANY(s.loc)'],
  ['shifts', 'location_id = ANY(s.loc)'],
  ['shift_swap_requests', 'shift_id IN (SELECT id FROM shifts WHERE location_id = ANY(s.loc)) OR requested_by_id = ANY(s.usr)'],
  ['time_off_requests', 'user_id = ANY(s.usr)'],
  ['attendance_logs', 'user_id = ANY(s.usr)'],
  ['monthly_attendance_summaries', 'user_id = ANY(s.usr)'],
  ['audit_logs', 'location_id = ANY(s.loc)'],
  ['voice_interaction_logs', 'location_id = ANY(s.loc) OR actor_id = ANY(s.usr)'],
  ['floor_plan_images', 'location_id = ANY(s.loc)'],
  ['floor_sections', 'location_id = ANY(s.loc)'],
  ['section_assignments', 'section_id IN (SELECT id FROM floor_sections WHERE location_id = ANY(s.loc)) OR staff_id = ANY(s.usr)'],
  ['eighty_six_items', 'location_id = ANY(s.loc)'],
  ['announcements', 'location_id = ANY(s.loc)'],
  ['shoutouts', 'location_id = ANY(s.loc) OR employee_id = ANY(s.usr)'],
  ['floor_feedback', 'location_id = ANY(s.loc) OR user_id = ANY(s.usr)'],
  ['rota_templates', 'location_id = ANY(s.loc)'],
  ['rota_publishes', 'location_id = ANY(s.loc)'],
  ['sessions', 'user_id = ANY(s.usr)'],
  ['login_links', 'user_id = ANY(s.usr)'],
  ['push_subscriptions', 'user_id = ANY(s.usr)'],
  ['notifications', 'user_id = ANY(s.usr)'],
  ['join_requests', 'location_id = ANY(s.loc)'],
  ['invite_links', 'location_id = ANY(s.loc)'],
  ['availability_marks', 'user_id = ANY(s.usr)'],
  ['policy_documents', 'location_id = ANY(s.loc)'],
  ['otp_codes', 'phone = ANY(s.phones)'],
];

// Rows in OTHER venues that the user cascades would delete too. Any hit blocks the org.
const OTHER_VENUE_ROWS: readonly (readonly [table: string, where: string])[] = [
  ['shift_swap_requests', 'requested_by_id = ANY(s.usr) AND shift_id NOT IN (SELECT id FROM shifts WHERE location_id = ANY(s.loc))'],
  ['attendance_logs', 'user_id = ANY(s.usr) AND shift_id IS NOT NULL AND shift_id NOT IN (SELECT id FROM shifts WHERE location_id = ANY(s.loc))'],
  ['voice_interaction_logs', 'actor_id = ANY(s.usr) AND NOT (location_id = ANY(s.loc))'],
  ['section_assignments', 'staff_id = ANY(s.usr) AND section_id NOT IN (SELECT id FROM floor_sections WHERE location_id = ANY(s.loc))'],
  ['shoutouts', 'employee_id = ANY(s.usr) AND NOT (location_id = ANY(s.loc))'],
  ['floor_feedback', 'user_id = ANY(s.usr) AND NOT (location_id = ANY(s.loc))'],
];

export interface Scope {
  orgIds: string[];
  locationIds: string[];
  userIds: string[];
  otpPhones: string[];
}

async function countRows(db: PrismaClient, spec: typeof DELETED_ROWS, scope: Scope): Promise<Record<string, number>> {
  const columns = spec.map(([table, where]) => `(SELECT count(*)::int FROM ${table} WHERE ${where}) AS "${table}"`).join(', ');
  const sql = `WITH s AS (SELECT $1::text[] AS loc, $2::text[] AS usr, $3::text[] AS org, $4::text[] AS phones) SELECT ${columns} FROM s`;
  const [row] = await db.$queryRawUnsafe<Record<string, number>[]>(sql, scope.locationIds, scope.userIds, scope.orgIds, scope.otpPhones);
  return row!;
}

export const countDeletedRows = (db: PrismaClient, scope: Scope) => countRows(db, DELETED_ROWS, scope);

export interface PlannedFile {
  fileUrl: string;
  /** null = not a plain file inside the uploads dir; never touched. */
  path: string | null;
  exists: boolean;
}

export interface PlannedOrg {
  id: string;
  name: string;
  createdAt: Date;
  locations: { id: string; name: string }[];
  users: { id: string; fullName: string; systemRole: string; phone: string | null }[];
  scope: Scope;
  counts: Record<string, number>;
  files: PlannedFile[];
  /** Non-empty = will not be deleted, and why. */
  blockedBy: string[];
}

export interface CleanupPlan {
  uploadsDir: string;
  name?: string;
  orgs: PlannedOrg[];
}

const exists = (path: string) => stat(path).then(() => true, () => false);

export async function buildCleanupPlan(db: PrismaClient, options: { uploadsDir: string; name?: string }): Promise<CleanupPlan> {
  const found = await db.organization.findMany({
    where: options.name !== undefined ? { name: options.name } : { OR: TEST_ORG_PREFIXES.map((prefix) => ({ name: { startsWith: prefix } })) },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      name: true,
      createdAt: true,
      locations: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          users: { orderBy: { createdAt: 'asc' }, select: { id: true, fullName: true, systemRole: true, phone: true } },
          floorPlanImages: { orderBy: { createdAt: 'asc' }, select: { fileUrl: true } },
          policyDocuments: { orderBy: { createdAt: 'asc' }, select: { fileUrl: true } },
        },
      },
    },
  });

  const orgs: PlannedOrg[] = [];
  // Re-checked here in JS: `_` is a LIKE wildcard, so the DB filter alone isn't an exact prefix match.
  for (const org of found.filter((o) => isTestOrgName(o.name))) {
    const users = org.locations.flatMap((l) => l.users);
    const locationIds = org.locations.map((l) => l.id);
    const userIds = users.map((u) => u.id);

    // Phones are global: keep the OTP rows of any phone another user or another venue's join request still has.
    const candidates = [...new Set(users.flatMap((u) => (u.phone ? [u.phone, toE164(u.phone)] : [])).filter((p): p is string => !!p))];
    const keep = new Set<string>();
    if (candidates.length) {
      const otherUsers = await db.user.findMany({
        where: { id: { notIn: userIds }, OR: [{ phone: { in: candidates } }, { phoneBeforeE164: { in: candidates } }] },
        select: { phone: true, phoneBeforeE164: true },
      });
      const otherRequests = await db.joinRequest.findMany({ where: { locationId: { notIn: locationIds }, phone: { in: candidates } }, select: { phone: true } });
      for (const p of [...otherUsers.flatMap((u) => [u.phone, u.phoneBeforeE164]), ...otherRequests.map((r) => r.phone)]) if (p) keep.add(p);
    }

    const scope: Scope = { orgIds: [org.id], locationIds, userIds, otpPhones: candidates.filter((p) => !keep.has(p)) };
    const otherVenueRows = await countRows(db, OTHER_VENUE_ROWS, scope);
    const blockedBy = Object.entries(otherVenueRows)
      .filter(([, n]) => n > 0)
      .map(([table, n]) => `its users have ${n} ${table} row(s) in other venues, which the delete would cascade into`);

    const fileUrls = org.locations.flatMap((l) => [...l.floorPlanImages, ...l.policyDocuments].map((f) => f.fileUrl));
    const files = await Promise.all(
      fileUrls.map(async (fileUrl) => {
        const path = uploadFilePath(options.uploadsDir, fileUrl);
        return { fileUrl, path, exists: path ? await exists(path) : false };
      }),
    );

    orgs.push({
      id: org.id,
      name: org.name,
      createdAt: org.createdAt,
      locations: org.locations.map((l) => ({ id: l.id, name: l.name })),
      users,
      scope,
      counts: await countDeletedRows(db, scope),
      files,
      blockedBy,
    });
  }
  return { uploadsDir: resolve(options.uploadsDir), name: options.name, orgs };
}

export interface OrgResult {
  org: PlannedOrg;
  deleted: boolean;
  error?: string;
  after?: Record<string, number>;
  files: { path: string; outcome: 'deleted' | 'already missing' | string }[];
}

/** One transaction per org; files are removed only after that org's transaction commits. */
export async function executeCleanupPlan(db: PrismaClient, plan: CleanupPlan): Promise<OrgResult[]> {
  const results: OrgResult[] = [];
  for (const org of plan.orgs) {
    if (org.blockedBy.length) {
      results.push({ org, deleted: false, error: `skipped: ${org.blockedBy.join('; ')}`, files: [] });
      continue;
    }
    try {
      await db.$transaction(async (tx) => {
        // shifts.role_id is ON DELETE RESTRICT: delete shifts first so the cascade never depends on trigger order.
        await tx.shift.deleteMany({ where: { locationId: { in: org.scope.locationIds } } });
        const { count } = await tx.organization.deleteMany({ where: { id: org.id, name: org.name } });
        if (count !== 1) throw new Error('the organization was renamed or removed after the plan was built');
        await tx.otpCode.deleteMany({ where: { phone: { in: org.scope.otpPhones } } });
      }, { timeout: 60_000 });
    } catch (err) {
      results.push({ org, deleted: false, error: `rolled back, nothing deleted: ${err instanceof Error ? err.message : String(err)}`, files: [] });
      continue;
    }
    const files: OrgResult['files'] = [];
    for (const file of org.files) {
      if (!file.path) continue;
      try {
        await unlink(file.path);
        files.push({ path: file.path, outcome: 'deleted' });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        files.push({ path: file.path, outcome: code === 'ENOENT' ? 'already missing' : `NOT deleted (${code ?? String(err)})` });
      }
    }
    results.push({ org, deleted: true, after: await countDeletedRows(db, org.scope), files });
  }
  return results;
}

const nonZero = (counts: Record<string, number>) => Object.entries(counts).filter(([, n]) => n > 0);

export function formatPlan(plan: CleanupPlan, host: string, confirm: boolean): string {
  const lines = [
    confirm ? 'Test-venue cleanup: DELETING (--confirm)' : 'Test-venue cleanup: DRY RUN, nothing will be deleted (add --confirm to delete)',
    `Database host: ${host}`,
    `Uploads dir:   ${plan.uploadsDir}`,
    plan.name !== undefined ? `Matching:      the org named exactly "${plan.name}"` : `Matching:      org names starting with ${TEST_ORG_PREFIXES.join(', ')}`,
    '',
    `${plan.orgs.length} organization(s) matched.`,
  ];
  plan.orgs.forEach((org, i) => {
    lines.push('', `[${i + 1}] ${org.name}`);
    lines.push(`    id ${org.id} · created ${org.createdAt.toISOString()} · ${org.locations.length} location(s) · ${org.users.length} user(s)`);
    for (const l of org.locations) lines.push(`    location ${l.id} "${l.name}"`);
    for (const u of org.users) lines.push(`    user ${u.id} ${u.systemRole} "${u.fullName}" ${u.phone ? redactPhone(u.phone) : '(no phone)'}`);
    lines.push(`    rows: ${nonZero(org.counts).map(([t, n]) => `${t} ${n}`).join(', ')} (every other table: 0)`);
    if (org.scope.otpPhones.length) lines.push(`    otp_codes phones: ${org.scope.otpPhones.map(redactPhone).join(', ')}`);
    for (const f of org.files) {
      lines.push(f.path ? `    file ${f.path} ${f.exists ? '(exists)' : '(already missing on disk)'}` : `    file ${f.fileUrl} (not inside the uploads dir: left alone)`);
    }
    for (const reason of org.blockedBy) lines.push(`    BLOCKED, will not be deleted: ${reason}`);
  });
  const deletable = plan.orgs.filter((o) => !o.blockedBy.length);
  const rows = deletable.reduce((sum, o) => sum + Object.values(o.counts).reduce((a, b) => a + b, 0), 0);
  const files = deletable.reduce((sum, o) => sum + o.files.filter((f) => f.path && f.exists).length, 0);
  lines.push('', `Total ${confirm ? 'to delete' : 'that --confirm would delete'}: ${deletable.length} organization(s), ${rows} row(s), ${files} file(s).`);
  return lines.join('\n');
}

export function formatResults(results: OrgResult[]): string {
  const lines = ['', 'Results:'];
  for (const r of results) {
    lines.push('', `${r.deleted ? 'DELETED' : 'NOT DELETED'} ${r.org.name} (${r.org.id})${r.error ? `: ${r.error}` : ''}`);
    const after = r.after;
    if (after) {
      const tables = Object.keys(r.org.counts).filter((t) => r.org.counts[t] || after[t]);
      lines.push(`    rows before -> after: ${tables.map((t) => `${t} ${r.org.counts[t]} -> ${after[t]}`).join(', ')}`);
    }
    for (const f of r.files) lines.push(`    file ${f.path}: ${f.outcome}`);
  }
  return lines.join('\n');
}
