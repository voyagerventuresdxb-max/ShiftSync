import { useMemo, useState } from 'react';
import { Moon, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { archiveShiftType, createShiftType, updateShiftType } from '@/api/rotaSetup';
import { OfflineActionNotice } from '@/components/shiftsync/OfflineNotice';
import { SHIFT_TINTS, rangesEndNextDay, validateRanges, type ShiftTint, type ShiftTypeDto, type TimeRange, type WeekDocDto, type WeekShiftDto } from '../../../shared/rotaWeek';
import { activeTypes } from '@/engine/rotaGrid';
import { ShiftChip } from './chips';
import { Dialog, btn } from './Dialog';
import { tintSwatch } from './Dock';

/**
 * The venue's shift types (Design board B4): list with this week's usage,
 * an editor for name, times (split toggle, "+1" when it ends the next day)
 * and chip colour from the palette family, and archive ("Delete") — not
 * offered while this week still uses the type. Changing the times updates
 * unpublished shifts of that type server-side; published ones keep theirs.
 */

const field =
  'min-h-11 w-full min-w-0 rounded-xl border border-border-strong bg-background/60 px-3 text-sm tabular-nums text-foreground focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-ring';
const label = 'mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const TINT_NAMES: Record<ShiftTint, string> = { gold: 'Gold', sand: 'Sand', clay: 'Clay', ochre: 'Ochre', sage: 'Sage', cream: 'Cream' };

interface Draft {
  id: string | null;
  name: string;
  ranges: TimeRange[];
  tint: ShiftTint;
}

const blank = (): Draft => ({ id: null, name: '', ranges: [{ start: '07:00', end: '16:00' }], tint: 'gold' });

export function ShiftTypeEditor(props: {
  week: WeekDocDto;
  locationId: string;
  token: string;
  online: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { week, locationId, token, online, onChanged, onClose } = props;
  const types = useMemo(() => activeTypes(week.shiftTypes), [week.shiftTypes]);
  const usage = (id: string) => week.shifts.filter((s) => s.shiftTypeId === id).length;
  const [draft, setDraft] = useState<Draft>(() => (types[0] ? fromType(types[0]) : blank()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const valid = validateRanges(draft.ranges) && draft.name.trim().length > 0;
  const nextDay = validateRanges(draft.ranges) && rangesEndNextDay(draft.ranges);
  const used = draft.id ? usage(draft.id) : 0;

  const run = async (fn: () => Promise<unknown>, done: string) => {
    if (!online) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await fn();
      setSaved(done);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the shift type.');
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!valid) return setError('Give it a name and times: one or two ranges, only the last may run past midnight.');
    const input = { name: draft.name.trim(), ranges: draft.ranges.map((r) => ({ start: r.start, end: r.end })), tint: draft.tint };
    if (draft.id) {
      const id = draft.id;
      void run(() => updateShiftType(token, locationId, id, input), `Saved ${input.name}.`);
    } else {
      void run(async () => {
        const created = await createShiftType(token, locationId, { ...input, sortOrder: types.length + 1 });
        setDraft(fromType(created));
      }, `Added ${input.name}.`);
    }
  };

  const archive = () => {
    if (!draft.id || used > 0) return;
    const id = draft.id;
    void run(async () => {
      await archiveShiftType(token, locationId, id);
      setDraft(blank());
    }, 'Shift type removed.');
  };

  const preview: WeekShiftDto = {
    id: 'preview',
    userId: 'preview',
    roleId: '',
    departmentId: null,
    shiftTypeId: 'preview',
    date: week.weekStart,
    ranges: draft.ranges,
    endsNextDay: nextDay,
    note: null,
    status: 'published',
    editedSincePublish: false,
    pendingRequestId: null,
  };
  const previewTypes: ShiftTypeDto[] = [{ id: 'preview', name: draft.name || 'New type', ranges: draft.ranges, endsNextDay: nextDay, tint: draft.tint, sortOrder: 0, archivedAt: null }];

  return (
    <Dialog title="Shift types" eyebrow="Venue settings" onClose={onClose} width="lg">
      <div className="grid gap-4 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <ul aria-label="Venue shift types" className="flex flex-col gap-1.5">
          {types.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => {
                  setDraft(fromType(t));
                  setError(null);
                  setSaved(null);
                }}
                aria-current={draft.id === t.id ? 'true' : undefined}
                className={cn(
                  'flex min-h-12 w-full items-center gap-2.5 rounded-xl border px-3 text-left text-sm font-semibold',
                  draft.id === t.id ? 'border-accent bg-accent/10' : 'border-border-strong bg-surface-raised hover:bg-surface',
                )}
              >
                <span aria-hidden="true" className="h-5 w-2.5 shrink-0 rounded-[3px]" style={tintSwatch(t.tint)} />
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                  {t.ranges.map((r) => `${r.start}–${r.end}`).join(' · ')} · {usage(t.id)} this week
                </span>
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => {
                setDraft(blank());
                setError(null);
                setSaved(null);
              }}
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong text-sm font-semibold text-muted-foreground hover:text-foreground"
            >
              <Plus aria-hidden="true" className="h-4 w-4" /> New shift type
            </button>
          </li>
        </ul>

        <div className="flex flex-col gap-3 rounded-2xl border border-border-strong bg-surface-raised p-3.5">
          <span className="eyebrow text-accent">{draft.id ? `Editing · ${draft.name}` : 'New shift type'}</span>
          <div>
            <label className={label} htmlFor="type-name">
              Name
            </label>
            <input id="type-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Morning" className={field} />
          </div>
          {draft.ranges.map((r, i) => (
            <div key={i} className="grid grid-cols-2 gap-2.5">
              <div>
                <label className={label} htmlFor={`type-start-${i}`}>
                  {draft.ranges.length === 2 ? (i === 0 ? 'First · starts' : 'Second · starts') : 'Starts'}
                </label>
                <input id={`type-start-${i}`} type="time" value={r.start} onChange={(e) => setDraft({ ...draft, ranges: draft.ranges.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)) })} className={field} />
              </div>
              <div>
                <label className={label} htmlFor={`type-end-${i}`}>
                  Ends
                </label>
                <input id={`type-end-${i}`} type="time" value={r.end} onChange={(e) => setDraft({ ...draft, ranges: draft.ranges.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)) })} className={field} />
              </div>
            </div>
          ))}
          {nextDay && (
            <p className="flex items-center gap-2 text-xs text-accent">
              <Moon aria-hidden="true" className="h-3.5 w-3.5" /> Ends the next day · shown as “+1” on the chip
            </p>
          )}
          <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl border border-border bg-surface px-3">
            <span className="flex flex-col">
              <span className="text-sm font-semibold">Split shift</span>
              <span className="text-xs text-muted-foreground">Two time ranges in one shift</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={draft.ranges.length === 2}
              onChange={() =>
                setDraft({
                  ...draft,
                  ranges:
                    draft.ranges.length === 2
                      ? [{ start: draft.ranges[0]!.start, end: draft.ranges[1]!.end }]
                      : [
                          { start: draft.ranges[0]!.start, end: '15:00' },
                          { start: '18:00', end: draft.ranges[0]!.end },
                        ],
                })
              }
              className="h-5 w-9 accent-accent"
            />
          </label>
          <div>
            <span className={label}>Colour · from the palette family</span>
            <div role="radiogroup" aria-label="Chip colour" className="flex flex-wrap gap-2">
              {SHIFT_TINTS.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={draft.tint === t}
                  aria-label={TINT_NAMES[t]}
                  onClick={() => setDraft({ ...draft, tint: t })}
                  className={cn('grid h-11 w-11 place-items-center rounded-xl border', draft.tint === t ? 'border-accent' : 'border-border-strong')}
                >
                  <span aria-hidden="true" className="h-[22px] w-[22px] rounded-md" style={tintSwatch(t)} />
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className={cn(label, 'mb-0')}>Preview</span>
            <div className="w-40">
              <ShiftChip shift={preview} types={previewTypes} clock={week.clock} />
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={save} disabled={!online || busy || !valid} className={cn(btn.base, btn.gold, 'flex-1')}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            {draft.id && (
              <button type="button" onClick={archive} disabled={!online || busy || used > 0} title={used > 0 ? `Used by ${used} shifts this week` : undefined} className={cn(btn.base, btn.danger)}>
                Delete
              </button>
            )}
          </div>
          {draft.id && used > 0 && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Delete is unavailable while {used} shift{used === 1 ? '' : 's'} this week use this type. Changing the times updates every unpublished shift of this type; published shifts keep their times until you edit them.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {saved && (
            <p role="status" className="text-sm text-success">
              {saved}
            </p>
          )}
          {!online && <OfflineActionNotice />}
        </div>
      </div>
    </Dialog>
  );
}

function fromType(t: ShiftTypeDto): Draft {
  return { id: t.id, name: t.name, ranges: t.ranges.map((r) => ({ ...r })), tint: t.tint };
}
