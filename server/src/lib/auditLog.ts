import type { Prisma, AuditAction } from '@prisma/client';
import type { prisma } from './prisma.js';

/** The entry shape `writeAuditLog` (and `withAuditedTransaction`'s `buildEntry`) accepts. */
export type AuditLogEntryInput = {
  locationId: string;
  actorId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  shiftId?: string | null;
  note?: string | null;
};

/**
 * Writes one AuditLog row — the single call shape that was hand-inlined at
 * 20+ sites across `routes/` and `lib/actions/` until this helper was
 * introduced (2026-08-31 tech-debt consolidation — see MEMORY.md), each one
 * re-specifying the same `{ locationId, actorId, action, entityType,
 * entityId, shiftId?, note? }` shape with no shared writer and no compiler
 * check that a field wasn't silently dropped. Takes either the top-level
 * `prisma` client or a `tx` handed in from inside `prisma.$transaction(...)`
 * — a caller that needs the audit write to commit atomically with its own
 * mutation (e.g. `signup.ts`'s venue-creation transaction) passes `tx`
 * through; everything else passes `prisma` directly.
 */
export async function writeAuditLog(
  client: Prisma.TransactionClient | typeof prisma,
  entry: AuditLogEntryInput,
): Promise<void> {
  await client.auditLog.create({ data: entry });
}

/**
 * Wraps the hand-copied `prisma.$transaction(async (tx) => { ...mutate...;
 * await writeAuditLog(tx, {...}); return x; })` shape that was independently
 * re-written at ~20 call sites across `routes/{staffDirectory,shifts,
 * rotaTemplates,attendance,floorPlan,policyDocuments,schedules,eightySix,
 * voice,swapRequests}.ts` and `lib/actions/{swapActions,joinActions}.ts`
 * (see MEMORY.md's "No shared `withAuditedTransaction` helper exists"
 * entries, named and deferred twice before this consolidation) into one
 * shared function — pure mechanical extraction, no behavior change.
 *
 * `mutate` may contain arbitrary logic (multiple Prisma calls, a re-fetch
 * after an `updateMany`, a conditional optimistic-concurrency guard that
 * throws a custom `Error` subclass on a failed `updateMany` — see
 * `swapActions.ts`'s `decideSwapRequest` and its `ShiftAlreadyReassignedError`).
 * A thrown error propagates out of this function uncaught, exactly as it
 * would out of a raw `prisma.$transaction(...)` call — a caller that needs
 * to catch it (translating it to a 409, say) wraps its OWN call to
 * `withAuditedTransaction` in that same `.catch(...)`, unchanged from today.
 *
 * `buildEntry` runs after `mutate` resolves and its return value (if any) is
 * written via `writeAuditLog(tx, ...)`; returning `null`/`undefined` skips
 * the write entirely (e.g. `floorPlan.ts`'s publish route, which only audits
 * when at least one row actually changed).
 *
 * A couple of call sites need their audit row committed BEFORE a delete in
 * the same transaction, not after (`shifts.ts`'s `DELETE /:id`,
 * `floorPlan.ts`'s `DELETE /assignments/:assignmentId`) — those call
 * `writeAuditLog(tx, ...)` directly from inside `mutate`, in the original
 * order, and return `null` from `buildEntry` so this helper doesn't also
 * write a second row.
 */
export async function withAuditedTransaction<T>(
  client: typeof prisma,
  mutate: (tx: Prisma.TransactionClient) => Promise<T>,
  buildEntry: (result: T) => AuditLogEntryInput | null | undefined,
): Promise<T> {
  return client.$transaction(async (tx) => {
    const result = await mutate(tx);
    const entry = buildEntry(result);
    if (entry) {
      await writeAuditLog(tx, entry);
    }
    return result;
  });
}
