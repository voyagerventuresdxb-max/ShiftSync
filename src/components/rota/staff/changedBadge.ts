import { weekDays, type IsoDate, type WeekDocDto } from '../../../../shared/rotaWeek';

/**
 * The staff week's "Changed" badge (Design board B7): a day is marked when
 * the person's own published shifts or leave for it differ from what this
 * device showed them last time they opened the week. The last-seen state is
 * kept per person, venue and week in localStorage, so it is a per-device
 * "since you last looked" — exactly what the badge promises — and needs no
 * server state. Storage may be missing or full; every access tolerates it.
 */

export interface SeenWeek {
  /** The week's published version when it was last viewed (informational). */
  publishedVersion: number | null;
  /** Per day, a signature of the person's shifts and leave that day. */
  days: Record<IsoDate, string>;
}

/** Signature of one person's day: type + times of each shift, or the leave type; '' for nothing. */
export function daySignatures(week: Pick<WeekDocDto, 'weekStart' | 'shifts' | 'leaves'>, userId: string): Record<IsoDate, string> {
  const out: Record<IsoDate, string> = {};
  for (const date of weekDays(week.weekStart)) {
    const shifts = week.shifts
      .filter((s) => s.userId === userId && s.date === date)
      .map((s) => `${s.shiftTypeId ?? 'custom'}@${s.ranges.map((r) => `${r.start}-${r.end}`).join(',')}`)
      .sort();
    const leave = week.leaves.find((l) => l.userId === userId && l.date === date);
    out[date] = [...shifts, ...(leave ? [`leave:${leave.type}`] : [])].join('|');
  }
  return out;
}

/**
 * Days whose signature changed since `seen`. Nothing is "changed" on the very
 * first view (no baseline), so a new device never lights up the whole week.
 */
export function changedDates(seen: SeenWeek | null, current: Record<IsoDate, string>): Set<IsoDate> {
  const out = new Set<IsoDate>();
  if (!seen) return out;
  for (const [date, sig] of Object.entries(current)) {
    const before = seen.days[date];
    if (before !== undefined && before !== sig) out.add(date);
    // A day the baseline never recorded is new to this device, not a change.
  }
  return out;
}

const PREFIX = 'shiftsync.staffWeek.seen.v1.';

export function seenKey(userId: string, locationId: string, weekStart: IsoDate): string {
  return `${PREFIX}${userId}.${locationId}.${weekStart}`;
}

export function loadSeen(key: string): SeenWeek | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SeenWeek>;
    if (!parsed || typeof parsed.days !== 'object' || parsed.days === null) return null;
    return { publishedVersion: typeof parsed.publishedVersion === 'number' ? parsed.publishedVersion : null, days: parsed.days as Record<IsoDate, string> };
  } catch {
    return null;
  }
}

export function saveSeen(key: string, seen: SeenWeek): void {
  try {
    localStorage.setItem(key, JSON.stringify(seen));
  } catch {
    // Quota or private mode: the badge simply will not show next time.
  }
}
