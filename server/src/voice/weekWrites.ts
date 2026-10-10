import { prisma } from '../lib/prisma.js';
import { applyWeekPatchIn, WeekPatchRefusedError, WeekVersionConflictError, type WeekPatchOk } from '../lib/actions/weekActions.js';
import type { IsoDate, WeekPatchOp, WeekPatchRefusal } from '../../../shared/rotaWeek.js';

/**
 * Voice roster writes (CREATE_SHIFT, EDIT_SHIFT, CANCEL_SHIFT) go through the week model, like a
 * drag on the grid: the same transactional core (`applyWeekPatchIn`, source 'voice'), so the
 * version bump, the one-live-shift-per-person-day rule, the leave and pending-request checks,
 * section clean-up and the audit trail are the grid's own. Usually one week; a shift moved into
 * another week is a create there and a delete here, both in ONE transaction (all or nothing).
 *
 * Voice has no week version on screen, so it presents the version the week is at when the
 * confirmed command runs: a writer that lands in between is a version conflict, and the whole
 * command is re-read and retried once before the caller is told the rota moved under them.
 */
export interface VoiceWeekPatch {
  weekStart: IsoDate;
  ops: WeekPatchOp[];
}

export type VoicePatchOutcome =
  | { result: 'ok'; weeks: { weekStart: IsoDate; version: number; results: WeekPatchOk['results']; declinedRequestIds: string[] }[] }
  | { result: 'refused'; refusal: WeekPatchRefusal; message: string }
  | { result: 'version_conflict' };

/** Same interactive-transaction limits as a grid patch (weekActions' PATCH_TX_OPTIONS). */
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

export async function applyVoicePatches(
  input: { locationId: string; actorId: string; transcript: string; patches: VoiceWeekPatch[]; overridePendingRequests?: boolean },
  client: typeof prisma = prisma,
): Promise<VoicePatchOutcome> {
  const { locationId, actorId, patches } = input;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const weeks = await client.$transaction(async (tx) => {
        const out: Extract<VoicePatchOutcome, { result: 'ok' }>['weeks'] = [];
        for (const p of patches) {
          const row = await tx.rotaWeek.findUnique({
            where: { locationId_weekStart: { locationId, weekStart: new Date(`${p.weekStart}T00:00:00.000Z`) } },
            select: { version: true },
          });
          const ok = await applyWeekPatchIn(tx, {
            locationId,
            weekStart: p.weekStart,
            actorId,
            source: 'voice',
            patch: {
              // A week nobody has written yet is created at version 1 by the first writer.
              expectedVersion: row?.version ?? 1,
              ops: p.ops,
              note: `"${input.transcript}"`,
              ...(input.overridePendingRequests ? { overridePendingRequests: true } : {}),
            },
          });
          out.push({ weekStart: p.weekStart, version: ok.version, results: ok.results, declinedRequestIds: ok.declinedRequestIds });
        }
        return out;
      }, TX_OPTIONS);
      return { result: 'ok', weeks };
    } catch (err) {
      if (err instanceof WeekPatchRefusedError) return { result: 'refused', refusal: err.refusal, message: err.message };
      if (err instanceof WeekVersionConflictError) continue;
      throw err;
    }
  }
  return { result: 'version_conflict' };
}

/** A pending time-off request on the person-day, and the confirmed command did not say to decline it. */
export const VOICE_PENDING_REQUEST =
  'That person has asked for that day off and the request is still pending. Say the command again to see it on the confirm sheet (confirming then declines the request), or decide the request first.';
/** Still conflicting after one re-read: someone else is editing the same week right now. */
export const VOICE_WEEK_MOVED = 'The rota changed while that was being saved. Say it again to see the week as it is now.';
export const VOICE_OTHER_WEEK = "A shift can't move into another week that way. Cancel it and create a new one instead.";

/** A week-patch refusal as the voice sheet says it, and its status: 409 for the person-day rules, 422 for the shape of the change. */
export function refusalReply(refusal: WeekPatchRefusal | 'version_conflict', message: string): { status: number; error: string } {
  switch (refusal) {
    case 'person_on_leave':
      return { status: 409, error: `${message} Pick another day or person.` };
    case 'already_has_shift':
      return { status: 409, error: 'That person already has a shift that day. Change that shift instead, or pick another day or person.' };
    case 'pending_request':
      return { status: 409, error: VOICE_PENDING_REQUEST };
    case 'overlap':
      return { status: 409, error: message };
    case 'version_conflict':
      return { status: 409, error: VOICE_WEEK_MOVED };
    case 'past_day':
      return { status: 400, error: 'That day has already passed.' };
    case 'outside_week':
      return { status: 422, error: VOICE_OTHER_WEEK };
    case 'unknown_shift':
    case 'unknown_person':
    case 'unknown_role':
    case 'unknown_shift_type':
      return { status: 404, error: message };
    default:
      return { status: 422, error: message };
  }
}
