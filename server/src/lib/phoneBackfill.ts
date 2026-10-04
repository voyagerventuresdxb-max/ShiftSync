import type { PrismaClient } from '@prisma/client';
import { toE164 } from './phone.js';

export type PhoneBackfillReport = {
  /** Already in E.164: nothing to do. */
  alreadyE164: number;
  /** Rewritten to E.164 (original kept in `phone_before_e164`). */
  converted: string[];
  /** Not a valid mobile number: left exactly as stored, needs a manager to fix it. */
  unparseable: string[];
  /** Would become the same E.164 as another user: ALL of them left as stored. */
  conflicts: string[];
  /** Pending/decided join requests whose phone was rewritten. */
  joinRequestsConverted: number;
};

/**
 * One-time, idempotent move of existing phone numbers to E.164 (#54).
 *
 * Safety rules, in order:
 * 1. A number is rewritten ONLY if `toE164` (the exact parser every route
 *    now uses) accepts it as a valid mobile number.
 * 2. It is rewritten ONLY if no other user already holds that E.164 and no
 *    other user's number would become it too. `User.phone` is unique, and a
 *    collision means two records claim one person's phone. Silently picking
 *    one would hand a login to the wrong record, so every record in the
 *    group is left as stored and reported (ids only, never the numbers).
 * 3. Nothing is ever deleted or nulled. Anything not rewritten keeps its
 *    exact stored value, and every rewritten row keeps its original in
 *    `phone_before_e164`, so the move can be reverted with one UPDATE.
 * 4. All writes happen in one transaction: either every planned rewrite
 *    lands or none does.
 *
 * A user left as stored can't sign in by phone (lookups now compare E.164)
 * until a manager re-saves their number in the Staff Directory, which
 * canonicalises it. The plan is computed over ALL users so collisions are
 * caught globally; `onlyUserIds` limits which rows are written (for tests).
 */
export async function backfillPhonesToE164(
  db: PrismaClient,
  opts: { dryRun?: boolean; onlyUserIds?: string[] } = {},
): Promise<PhoneBackfillReport> {
  const users = await db.user.findMany({ where: { phone: { not: null } }, select: { id: true, phone: true } });
  const report: PhoneBackfillReport = { alreadyE164: 0, converted: [], unparseable: [], conflicts: [], joinRequestsConverted: 0 };

  // Everyone who holds, or would hold, each E.164 number.
  const claimants = new Map<string, string[]>();
  const pending: { id: string; from: string; to: string }[] = [];
  for (const u of users) {
    const to = toE164(u.phone!);
    if (!to) {
      report.unparseable.push(u.id);
      continue;
    }
    claimants.set(to, [...(claimants.get(to) ?? []), u.id]);
    if (to === u.phone) report.alreadyE164++;
    else pending.push({ id: u.id, from: u.phone!, to });
  }

  const inScope = (id: string) => !opts.onlyUserIds || opts.onlyUserIds.includes(id);
  const rewrites = pending.filter((p) => {
    if ((claimants.get(p.to) ?? []).length > 1) {
      report.conflicts.push(p.id);
      return false;
    }
    return inScope(p.id);
  });
  report.unparseable = report.unparseable.filter(inScope);
  report.conflicts = report.conflicts.filter(inScope);

  const joinRequests = await db.joinRequest.findMany({ select: { id: true, phone: true } });
  const joinRewrites = joinRequests
    .map((j) => ({ id: j.id, to: toE164(j.phone) }))
    .filter((j, i): j is { id: string; to: string } => j.to !== null && j.to !== joinRequests[i]!.phone);

  report.converted = rewrites.map((r) => r.id);
  report.joinRequestsConverted = opts.onlyUserIds ? 0 : joinRewrites.length;
  if (opts.dryRun) return report;

  await db.$transaction(async (tx) => {
    for (const r of rewrites) {
      // `phone: r.from` in the WHERE: if the row changed since it was read, skip it rather than overwrite.
      await tx.user.updateMany({ where: { id: r.id, phone: r.from }, data: { phone: r.to, phoneBeforeE164: r.from } });
    }
    if (!opts.onlyUserIds) {
      for (const j of joinRewrites) await tx.joinRequest.update({ where: { id: j.id }, data: { phone: j.to } });
    }
  });
  return report;
}

/** One log line with counts and user ids, never phone numbers. */
export function describePhoneBackfill(r: PhoneBackfillReport, dryRun: boolean): string {
  const verb = dryRun ? 'would convert' : 'converted';
  return (
    `[phone-e164] ${verb} ${r.converted.length} user phone(s) and ${r.joinRequestsConverted} join request(s); ` +
    `${r.alreadyE164} already E.164; ` +
    `${r.unparseable.length} not a valid mobile (left as stored)${r.unparseable.length ? `: ${r.unparseable.join(', ')}` : ''}; ` +
    `${r.conflicts.length} in a collision (left as stored)${r.conflicts.length ? `: ${r.conflicts.join(', ')}` : ''}.`
  );
}
