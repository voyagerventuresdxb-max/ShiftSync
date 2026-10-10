import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { fetchWeekDoc } from '@/api/weeks';
import { venueReadHeaders } from '@/api/venueBinding';
import { OfflineActionNotice } from '@/components/shiftsync/OfflineNotice';
import { addDays, weekDays, type IsoDate, type WeekDocDto, type WeekPatchOp } from '../../../shared/rotaWeek';
import { weekRangeLabel } from '@/engine/weekMath';
import { shortDay } from '@/engine/rotaGrid';
import { dayOffsOfWeek, entriesOfWeek, planCopy, replaceableCount, type CopyAttention } from '@/engine/rotaPlans';
import { Dialog, btn } from './Dialog';

/**
 * Copy last week (Design board B5): weekday → weekday into the week on
 * screen, with a conflict preview first — people now on leave, with a
 * pending request, or no longer here get open shifts instead, so the gap
 * shows in the coverage row. "Fill empty cells only" keeps what is already
 * placed; "Replace" overwrites it. Day-off statuses can come along
 * (manager-set Day off only; approved leave is never copied). The whole copy
 * is ONE patch and one undo step; the source week is never touched.
 */

const andList = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export function CopyWeekDialog(props: {
  week: WeekDocDto;
  locationId: string;
  token: string;
  today: IsoDate;
  online: boolean;
  onApply: (ops: WeekPatchOp[], label: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { week, locationId, token, today, online, onApply, onClose } = props;
  const sourceStart = addDays(week.weekStart, -7);
  const [source, setSource] = useState<WeekDocDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'fill' | 'replace'>('fill');
  const [copyStatuses, setCopyStatuses] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchWeekDoc(locationId, sourceStart, venueReadHeaders(token, null))
      .then((doc) => !cancelled && setSource(doc))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : 'Could not load last week.'));
    return () => {
      cancelled = true;
    };
  }, [locationId, sourceStart, token]);

  const plan = useMemo(
    () =>
      source
        ? planCopy({
            target: week,
            entries: entriesOfWeek(source),
            dayOffs: copyStatuses ? dayOffsOfWeek(source) : [],
            mode,
            today,
            missingPerson: 'open',
          })
        : null,
    [source, week, copyStatuses, mode, today],
  );

  const targetDays = weekDays(week.weekStart);
  const sourceDays = weekDays(sourceStart);
  const existing = week.shifts.filter((s) => s.date >= today).length;
  const replaceable = replaceableCount(week, today);
  const requestsNotCopied = source ? source.leaves.filter((l) => l.fromRequest).length : 0;
  const nameOf = (id: string) => (week.people.find((p) => p.id === id) ?? source?.people.find((p) => p.id === id))?.fullName ?? 'Someone';

  const copy = async () => {
    if (!plan || busy) return;
    setBusy(true);
    try {
      const ok = await onApply(plan.ops, `Copied last week (${plan.created})`);
      if (ok) onClose();
    } finally {
      setBusy(false);
    }
  };

  const attention = (a: CopyAttention) => {
    const pill = a.reason === 'leave' ? 'Leave' : a.reason === 'inactive' ? 'Left' : 'Requested';
    const who =
      a.reason === 'inactive'
        ? `${nameOf(a.userId)} · no longer active`
        : `${nameOf(a.userId)} · ${a.reason === 'leave' ? 'on leave' : 'asked for time off'} ${a.dates.map(shortDay).join(', ')}`;
    return (
      <li key={`${a.userId}-${a.reason}`} className="flex items-start gap-2.5 rounded-xl border border-border bg-surface-raised p-3">
        <span className="mt-0.5 shrink-0 rounded-full border border-[color-mix(in_oklab,var(--rota-ochre)_55%,transparent)] px-[7px] py-px text-[10px] font-bold uppercase tracking-[0.06em] text-[var(--rota-ochre)]">{pill}</span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold">{who}</span>
          <span className="block text-xs text-muted-foreground">
            {a.count} shift{a.count === 1 ? '' : 's'} {a.count === 1 ? 'goes' : 'go'} to Open shifts so you can cover {a.count === 1 ? 'it' : 'them'}.
          </span>
        </span>
      </li>
    );
  };

  return (
    <Dialog title={`From ${weekRangeLabel(sourceDays[0]!, sourceDays[6]!)}`} eyebrow={`Copy into ${weekRangeLabel(targetDays[0]!, targetDays[6]!)}`} onClose={onClose} width="md" dismissable={!busy}>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : !source || !plan ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-xl bg-surface-raised motion-reduce:animate-none" />
          ))}
        </div>
      ) : source.shifts.length === 0 ? (
        <p className="text-sm text-muted-foreground">Last week has no shifts to copy.</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {source.shifts.length} shifts · {new Set(source.shifts.map((s) => s.userId).filter(Boolean)).size} people
            {requestsNotCopied > 0 && ` · ${requestsNotCopied} day${requestsNotCopied === 1 ? '' : 's'} of approved leave not copied`}
          </p>
          {plan.attention.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Needs your attention · {plan.attention.length}</p>
              <ul className="space-y-1.5">{plan.attention.map(attention)}</ul>
            </div>
          )}
          <fieldset>
            <legend className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Where the new week already has shifts</legend>
            <div className="space-y-1.5">
              {(
                [
                  ['fill', `Fill empty cells only · keeps the ${existing} you placed`],
                  ['replace', `Replace everything · ${replaceable} shift${replaceable === 1 ? '' : 's'} overwritten`],
                ] as const
              ).map(([value, text]) => (
                <label key={value} className={cn('flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 text-sm', mode === value ? 'border-accent bg-accent/10' : 'border-border-strong bg-surface-raised')}>
                  <input type="radio" name="copy-mode" value={value} checked={mode === value} onChange={() => setMode(value)} className="accent-[var(--accent)]" />
                  {text}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl border border-border bg-surface-raised px-3 text-sm">
            Copy day-off statuses too
            <input type="checkbox" role="switch" checked={copyStatuses} onChange={(e) => setCopyStatuses(e.target.checked)} className="h-5 w-9 accent-[var(--accent)]" />
          </label>
          {(plan.skippedPast > 0 || plan.keptExisting > 0 || plan.dropped > 0) && (
            <p className="text-xs text-muted-foreground">
              {andList(
                [
                  plan.keptExisting ? `${plan.keptExisting} kept as you placed them` : '',
                  plan.skippedPast ? `${plan.skippedPast} on days that have passed skipped` : '',
                  plan.dropped ? `${plan.dropped} without a role skipped` : '',
                ].filter(Boolean),
              )}
              .
            </p>
          )}
          <p className="text-xs text-muted-foreground">One undo step for the whole copy. Last week is not touched.</p>
          {!online && <OfflineActionNotice />}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={busy} className={cn(btn.base, btn.ghost)}>
              Cancel
            </button>
            <button type="button" data-autofocus onClick={() => void copy()} disabled={!online || busy || plan.ops.length === 0} className={cn(btn.base, btn.gold)}>
              {busy ? 'Copying…' : `Copy ${plan.created} shift${plan.created === 1 ? '' : 's'}${plan.dayOffs ? ` + ${plan.dayOffs} day${plan.dayOffs === 1 ? '' : 's'} off` : ''}`}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
