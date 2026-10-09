import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

/**
 * One voice Confirm runs once. The app makes a key for each preview and sends it with Confirm; the
 * key is claimed here (a unique row per venue + person + key) BEFORE the change is made, and
 * finished after it with the answer that was sent. So, independently of the voice log:
 *  - the same key again (a double tap, a retry after a timeout) gets the stored answer, and
 *    nothing is done twice;
 *  - while the first is still running, or when its outcome is unknown (the server stopped half
 *    way), a retry is refused ("I couldn't confirm whether that went through. Check the schedule,
 *    then preview it again"), never run;
 *  - a Confirm that was refused before anything changed (FAILED) may be tried again;
 *  - a key someone else (another person or venue) already used is refused.
 * Keys expire after 24 hours and are swept.
 */

export const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
/** A claim this old with no answer: the server stopped mid-way; its outcome is unknown. */
const STALE_PENDING_MS = 2 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const KEY_RE = /^[A-Za-z0-9_-]{16,100}$/;

export function confirmationKey(raw: unknown): string | null {
  return typeof raw === 'string' && KEY_RE.test(raw) ? raw : null;
}

export type Claim =
  | { kind: 'claimed'; id: string }
  | { kind: 'replay'; status: number; body: Prisma.JsonValue }
  | { kind: 'refused'; status: number; body: { error: string; errorCode: string } };

/** Where the person can see for themselves whether a command went through. */
function whereToCheck(intent: string): string {
  if (intent === 'POST_ANNOUNCEMENT') return 'the announcements';
  if (intent === 'POST_SHOUTOUT') return 'the shout-outs';
  if (intent === 'APPROVE_JOIN' || intent === 'DECLINE_JOIN') return 'the join requests in People';
  return 'the schedule';
}
const inProgress = (intent: string) => ({
  error: `That's still going through. Check ${whereToCheck(intent)} in a moment, then preview it again if it's still needed.`,
  errorCode: 'voice_confirm_in_progress',
});
const unknown = (intent: string) => ({
  error: `I couldn't confirm whether that went through. Check ${whereToCheck(intent)}, then preview it again if it's still needed.`,
  errorCode: 'voice_confirm_unknown',
});
const NOT_YOURS = { error: 'That confirmation belongs to someone else.', errorCode: 'voice_key_conflict' };

let lastSweep = 0;

/** Deletes expired keys (at most once an hour per server, from the Confirm path). */
export async function sweepExpiredConfirmations(now = new Date()): Promise<number> {
  lastSweep = now.getTime();
  const { count } = await prisma.voiceConfirmation.deleteMany({ where: { expiresAt: { lt: now } } });
  return count;
}

type Row = { id: string; locationId: string; userId: string; intent: string; status: string; responseStatus: number | null; responseBody: Prisma.JsonValue | null; updatedAt: Date };

async function fromExisting(row: Row, owner: { locationId: string; userId: string }, now: Date): Promise<Claim> {
  if (row.locationId !== owner.locationId || row.userId !== owner.userId) return { kind: 'refused', status: 409, body: NOT_YOURS };
  if (row.status === 'DONE') return { kind: 'replay', status: row.responseStatus ?? 200, body: row.responseBody };
  if (row.status === 'PENDING') {
    return { kind: 'refused', status: 409, body: now.getTime() - row.updatedAt.getTime() > STALE_PENDING_MS ? unknown(row.intent) : inProgress(row.intent) };
  }
  // FAILED: refused before anything changed; this attempt takes the key over, if no one else did.
  const { count } = await prisma.voiceConfirmation.updateMany({ where: { id: row.id, status: 'FAILED' }, data: { status: 'PENDING' } });
  return count === 1 ? { kind: 'claimed', id: row.id } : { kind: 'refused', status: 409, body: inProgress(row.intent) };
}

export async function claimConfirmation(input: { key: string; locationId: string; userId: string; intent: string }, now = new Date()): Promise<Claim> {
  if (now.getTime() - lastSweep > SWEEP_EVERY_MS) await sweepExpiredConfirmations(now).catch(() => {});
  const owner = { locationId: input.locationId, userId: input.userId };
  const existing = await prisma.voiceConfirmation.findFirst({ where: { key: input.key, expiresAt: { gt: now } } });
  if (existing) return fromExisting(existing, owner, now);
  // The same person's expired use of this key (not yet swept) gives way to this one.
  await prisma.voiceConfirmation.deleteMany({ where: { key: input.key, ...owner, expiresAt: { lte: now } } });
  try {
    const row = await prisma.voiceConfirmation.create({
      data: { key: input.key, ...owner, intent: input.intent, status: 'PENDING', expiresAt: new Date(now.getTime() + CONFIRMATION_TTL_MS) },
    });
    return { kind: 'claimed', id: row.id };
  } catch (err) {
    // Two taps in the same instant: the other one holds the key.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const row = await prisma.voiceConfirmation.findFirst({ where: { key: input.key, ...owner } });
      if (row) return fromExisting(row, owner, now);
    }
    throw err;
  }
}

/** Records the answer sent for a claimed key: DONE (it ran) or FAILED (refused, nothing changed). */
export async function finishConfirmation(id: string, status: number, body: Record<string, unknown>): Promise<void> {
  await prisma.voiceConfirmation.update({
    where: { id },
    data: { status: status < 400 ? 'DONE' : 'FAILED', responseStatus: status, responseBody: body as Prisma.InputJsonValue },
  });
}
