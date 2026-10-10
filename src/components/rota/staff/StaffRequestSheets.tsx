import { useState } from 'react';
import { addDays, formatRange, type IsoDate, type ShiftTypeDto, type WeekPersonDto, type WeekShiftDto } from '../../../../shared/rotaWeek';
import { cn } from '../../../lib/utils';
import { OfflineActionNotice } from '../../shiftsync/OfflineNotice';
import { BottomSheet, SheetHeader } from '../phone/BottomSheet';
import { ApiError, requestSwap, requestTimeOff } from './requestsApi';
import { longDate } from './weekModel';

/**
 * The two request sheets behind "My week" (Design board B7). Loaded on
 * demand, so the staff screen itself stays light.
 */

const REASON_MAX = 200;

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError || err instanceof Error) return err.message || fallback;
  return fallback;
}

export function TimeOffSheet(props: { token: string; today: IsoDate; initialDate: IsoDate; online: boolean; onDone: (message: string) => void; onClose: () => void }) {
  const { token, today, initialDate, online, onDone, onClose } = props;
  const [start, setStart] = useState<IsoDate>(initialDate < today ? today : initialDate);
  const [end, setEnd] = useState<IsoDate>(initialDate < today ? today : initialDate);
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && start >= today && end >= start && end <= addDays(start, 60);

  const send = async () => {
    if (!valid || !online) return;
    setSending(true);
    setError(null);
    try {
      await requestTimeOff(token, { startDate: start, endDate: end, reason: reason.trim() || null });
      onDone(start === end ? `Time off requested for ${longDate(start)}. Your manager will review it.` : `Time off requested, ${longDate(start)} to ${longDate(end)}. Your manager will review it.`);
    } catch (err) {
      setError(errorText(err, 'Could not send that request.'));
    } finally {
      setSending(false);
    }
  };

  return (
    <BottomSheet label="Request time off" onClose={onClose}>
      <SheetHeader eyebrow="Request" title="Time off" sub="Your manager sees it in their requests and decides." onClose={onClose} />
      <div className="grid grid-cols-2 gap-2.5">
        <label className="flex min-w-0 flex-col gap-1.5 text-xs font-semibold tracking-[0.04em] text-muted-foreground">
          From
          <input
            type="date"
            data-autofocus
            value={start}
            min={today}
            onChange={(e) => {
              setStart(e.target.value);
              if (e.target.value > end) setEnd(e.target.value);
            }}
            className="min-h-11 w-full rounded-xl border border-border-strong bg-surface px-3 text-[15px] text-foreground"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5 text-xs font-semibold tracking-[0.04em] text-muted-foreground">
          To
          <input
            type="date"
            value={end}
            min={start}
            onChange={(e) => setEnd(e.target.value)}
            className="min-h-11 w-full rounded-xl border border-border-strong bg-surface px-3 text-[15px] text-foreground"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1.5 text-xs font-semibold tracking-[0.04em] text-muted-foreground">
        <span className="flex justify-between">
          <span>Reason (optional)</span>
          <span className="tabular-nums">
            {reason.length}/{REASON_MAX}
          </span>
        </span>
        <textarea
          value={reason}
          maxLength={REASON_MAX}
          rows={2}
          onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))}
          className="min-h-11 w-full resize-none rounded-xl border border-border-strong bg-surface px-3 py-2 text-[15px] text-foreground"
        />
      </label>
      {!valid && <p className="text-xs text-muted-foreground">Pick days from today on, up to 60 days in one request.</p>}
      {error && (
        <div className="error-block" role="alert">
          <p>{error}</p>
        </div>
      )}
      <button
        type="button"
        disabled={!valid || sending || !online}
        onClick={() => void send()}
        className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-[15px] font-semibold text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        {sending && <span className="spinner" aria-hidden="true" />}
        {sending ? 'Sending…' : 'Send request'}
      </button>
      {!online && <OfflineActionNotice />}
    </BottomSheet>
  );
}

export function SwapSheet(props: {
  token: string;
  shifts: WeekShiftDto[];
  types: ShiftTypeDto[];
  clock: '12h' | '24h';
  colleagues: WeekPersonDto[];
  online: boolean;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const { token, shifts, types, clock, colleagues, online, onDone, onClose } = props;
  const [shiftId, setShiftId] = useState<string>(shifts[0]?.id ?? '');
  const [targetId, setTargetId] = useState<string>('');
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = (s: WeekShiftDto) =>
    `${longDate(s.date)} · ${types.find((t) => t.id === s.shiftTypeId)?.name ?? 'Shift'} ${s.ranges.map((r) => formatRange(r, clock)).join(' · ')}${s.endsNextDay ? ' (+1)' : ''}`;

  const send = async () => {
    const shift = shifts.find((s) => s.id === shiftId);
    const target = colleagues.find((p) => p.id === targetId);
    if (!shift || !target || !online) return;
    setSending(true);
    setError(null);
    try {
      await requestSwap(token, { shiftId: shift.id, targetUserId: target.id, reason: reason.trim() || undefined });
      onDone(`Swap requested: ${target.fullName.split(/\s+/)[0]} for ${longDate(shift.date)}. Your manager will review it.`);
    } catch (err) {
      setError(errorText(err, 'Could not send that swap request.'));
    } finally {
      setSending(false);
    }
  };

  return (
    <BottomSheet label="Swap a shift" onClose={onClose}>
      <SheetHeader eyebrow="Request" title="Swap a shift" sub="Ask a colleague to take one of your shifts. Your manager approves it." onClose={onClose} />
      {shifts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No upcoming shifts this week that you can offer.</p>
      ) : (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-xs font-semibold tracking-[0.04em] text-muted-foreground">Your shift</legend>
            {shifts.map((s) => (
              <label
                key={s.id}
                className={cn(
                  'flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border bg-surface px-3 text-sm font-medium',
                  shiftId === s.id ? 'border-accent ring-2 ring-accent/35' : 'border-border-strong',
                )}
              >
                <input type="radio" name="swap-shift" value={s.id} checked={shiftId === s.id} onChange={() => setShiftId(s.id)} className="h-4 w-4 accent-[var(--accent)]" />
                <span className="min-w-0 tabular-nums">{label(s)}</span>
              </label>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1.5 text-xs font-semibold tracking-[0.04em] text-muted-foreground">
            Who could take it
            <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="min-h-11 w-full rounded-xl border border-border-strong bg-surface px-3 text-[15px] text-foreground">
              <option value="">Choose a colleague</option>
              {colleagues.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName}
                  {p.roleTitle ? ` · ${p.roleTitle}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-semibold tracking-[0.04em] text-muted-foreground">
            Note for your manager (optional)
            <input
              value={reason}
              maxLength={REASON_MAX}
              onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))}
              className="min-h-11 w-full rounded-xl border border-border-strong bg-surface px-3 text-[15px] text-foreground"
            />
          </label>
          {error && (
            <div className="error-block" role="alert">
              <p>{error}</p>
            </div>
          )}
          <button
            type="button"
            disabled={!shiftId || !targetId || sending || !online}
            onClick={() => void send()}
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-[15px] font-semibold text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending && <span className="spinner" aria-hidden="true" />}
            {sending ? 'Sending…' : 'Send swap request'}
          </button>
          {!online && <OfflineActionNotice />}
        </>
      )}
    </BottomSheet>
  );
}
