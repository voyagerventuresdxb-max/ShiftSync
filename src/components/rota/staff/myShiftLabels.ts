import type { MyShiftV2Fields, TimeRange } from '../../../../shared/rotaWeek';

/**
 * Labels for one GET /api/my-shifts item (My shifts list, Home next-shift
 * card). The v2 fields are optional: an older server sends only
 * startLabel/endLabel, and the card must read exactly as it did before.
 */
export interface MyShiftLike extends Partial<MyShiftV2Fields> {
  startLabel: string;
  endLabel: string;
}

export interface MyShiftLabels {
  /** "Evening"; null when the server has no type for it (an older server, or custom times). */
  typeName: string | null;
  /** "16:00–01:00", or both ranges of a split: "11:00–15:00 · 18:00–23:00". */
  times: string;
  /** The shift ends the next day: render a "+1" marker after the times. */
  nextDay: boolean;
  note: string | null;
}

function validRanges(r: unknown): r is TimeRange[] {
  return Array.isArray(r) && r.length > 0 && r.every((x) => x && typeof x.start === 'string' && typeof x.end === 'string');
}

export function myShiftLabels(s: MyShiftLike): MyShiftLabels {
  const split = validRanges(s.ranges) && s.ranges.length > 1;
  const times = split ? s.ranges!.map((r) => `${r.start}–${r.end}`).join(' · ') : `${s.startLabel}–${s.endLabel}`;
  const nextDay = typeof s.endsNextDay === 'boolean' ? s.endsNextDay : s.endLabel <= s.startLabel && s.endLabel !== s.startLabel && /^\d\d:\d\d$/.test(s.endLabel);
  const note = typeof s.note === 'string' && s.note.trim() ? s.note.trim() : null;
  return { typeName: s.shiftTypeName?.trim() || null, times, nextDay, note };
}
