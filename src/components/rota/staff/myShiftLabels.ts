import type { MyShiftV2Fields } from '../../../../shared/rotaWeek';

/**
 * Labels for one GET /api/my-shifts item (My shifts list, Home next-shift
 * card). The v2 fields are optional: an older server sends only
 * startLabel/endLabel, and the line must read exactly as it did before.
 * (Kept tiny: it ships in the entry chunk with Home and My shifts.)
 */
export function myShiftLabels(s: { startLabel: string; endLabel: string } & Partial<MyShiftV2Fields>) {
  const split = Array.isArray(s.ranges) && s.ranges.length > 1;
  return {
    /** "Evening"; null when the server sends no type (older server, custom times). */
    typeName: s.shiftTypeName?.trim() || null,
    /** "16:00–01:00", or both parts of a split: "11:00–15:00 · 18:00–23:00". */
    times: split ? s.ranges!.map((r) => `${r.start}–${r.end}`).join(' · ') : `${s.startLabel}–${s.endLabel}`,
    /** Ends the next day: show "+1". An older server's labels still tell (end at or before start). */
    nextDay: s.endsNextDay ?? s.endLabel < s.startLabel,
    note: s.note?.trim() || null,
  };
}
