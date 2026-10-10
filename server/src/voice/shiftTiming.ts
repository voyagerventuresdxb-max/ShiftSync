import type { ParsedIntent } from './intentSchema.js';
import type { VenueContext } from './context.js';
import type { ToolCall } from './tools.js';
import type { ShiftTimes } from './times.js';
import type { TimeRange } from '../../../shared/rotaWeek.js';
import { normalizeName } from './people.js';
import { resolveTerm } from './vocabulary.js';

/**
 * Shift timing for voice writes, kept free of the database so it is tested word for word
 * (shiftTiming.test.ts): naming a venue shift type ("put Omar on evening", "make Priya's Friday a
 * split") and the ranges an edited shift ends up with.
 */

const clarify = (reason: string, summary: string): ParsedIntent => ({ intent: 'UNRECOGNIZED', reason, summary });

export type ShiftTypeEntry = NonNullable<VenueContext['shiftTypes']>[number];
export type TypeLookup = { kind: 'none' } | { kind: 'types'; types: ShiftTypeEntry[] } | { kind: 'final'; intent: ParsedIntent };

/** Every word of the type's name is in what was said ("the mid", "evening shift"). */
function namesType(transcript: string, t: ShiftTypeEntry): boolean {
  const said = new Set(normalizeName(transcript).split(' '));
  const own = normalizeName(t.name).split(' ').filter(Boolean);
  return own.length > 0 && own.every((w) => said.has(w));
}

/**
 * A named shift type ("put Omar on evening", "make Priya's Friday a split"): the venue's own
 * live types, looked up like a role or section. Without the argument, a new shift with no times
 * said may still name exactly one type in the caller's words ("a morning shift for Omar").
 */
export function shiftTypeFor(call: Pick<ToolCall, 'args'>, ctx: Pick<VenueContext, 'shiftTypes'>, transcript: string, fromWords: boolean): TypeLookup {
  const types = ctx.shiftTypes ?? [];
  // Times said win: "Omar on evening, 5 to 1" is those times (a type word next to them only describes them).
  if (call.args.start || call.args.end) return { kind: 'none' };
  const heard = call.args.shiftType?.replace(/\bshifts?\b/gi, ' ').trim();
  if (heard) {
    const found = resolveTerm(heard, types.map((t) => ({ id: t.id, label: t.name })));
    const ids = found.kind === 'one' ? [found.item.id] : found.kind === 'choice' ? found.items.map((i) => i.id) : [];
    if (ids.length) return { kind: 'types', types: types.filter((t) => ids.includes(t.id)) };
    const example = /split/i.test(heard) ? '"11 to 3 and 6 to 11"' : '"4pm to 1am"';
    return { kind: 'final', intent: clarify(`Say the times instead, for example ${example}.`, `Your venue has no ${heard} shift type.`) };
  }
  if (fromWords && !call.args.start2 && transcript.trim()) {
    const named = types.filter((t) => namesType(transcript, t));
    if (named.length === 1) return { kind: 'types', types: named };
  }
  return { kind: 'none' };
}

/** A type's ranges as a reading's times: the first range in start/end, a split's second in `second`. */
export function typeTimes(t: ShiftTypeEntry): { start: string; end: string; second?: ShiftTimes } {
  const [first, second] = t.ranges;
  return { start: first!.start, end: first!.end, ...(second ? { second: { start: second.start, end: second.end } } : {}) };
}

/**
 * The ranges an EDIT_SHIFT leaves a shift with, from its current ranges: a split keeps its break
 * unless the command reshaped it (a split type, a second part, or `second: null` to make it one
 * range again); a new start moves the first range's start, a new end the last range's end.
 * Undefined when the times do not change.
 */
export function editedRanges(
  current: TimeRange[],
  change: { start?: string; end?: string; second?: { start: string; end: string } | null; shiftTypeId?: string },
): TimeRange[] | undefined {
  if (change.start === undefined && change.end === undefined && change.second === undefined && change.shiftTypeId === undefined) return undefined;
  const first = current[0]!;
  const last = current[current.length - 1]!;
  if (change.second !== undefined) {
    return [{ start: change.start ?? first.start, end: change.end ?? first.end }, ...(change.second ? [{ start: change.second.start, end: change.second.end }] : [])];
  }
  if (current.length === 2) return [{ start: change.start ?? first.start, end: first.end }, { start: last.start, end: change.end ?? last.end }];
  return [{ start: change.start ?? first.start, end: change.end ?? first.end }];
}
