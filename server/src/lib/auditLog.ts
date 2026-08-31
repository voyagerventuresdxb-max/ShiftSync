import type { Prisma, AuditAction } from '@prisma/client';
import type { prisma } from './prisma.js';

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
  entry: {
    locationId: string;
    actorId: string | null;
    action: AuditAction;
    entityType: string;
    entityId: string;
    shiftId?: string | null;
    note?: string | null;
  },
): Promise<void> {
  await client.auditLog.create({ data: entry });
}
