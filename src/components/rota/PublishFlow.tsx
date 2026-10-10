import { useCallback, useEffect, useState } from 'react';
import { Bell, CheckCircle2, Link2, PhoneCall } from 'lucide-react';
import { cn } from '@/lib/utils';
import { OfflineActionNotice } from '@/components/shiftsync/OfflineNotice';
import { initialsOf, weekDays, type PublishDiffRow, type PublishPreviewDto, type PublishResult, type WeekDocDto } from '../../../shared/rotaWeek';
import { fullDate, shortDay } from '@/engine/rotaGrid';
import { weekRangeLabel } from '@/engine/weekMath';
import { Dialog, DISPLAY, btn } from './Dialog';

/**
 * Publish (Design board B6): review the server's per-person diff, confirm in
 * the confirm-sheet pattern, then a success state. Publishing never blocks on
 * an uncovered shift — only on being offline. The preview's fingerprint is
 * presented back; if the week moved meanwhile the server answers with a new
 * preview (or a version conflict) and the manager reviews again. People are
 * "told" in the app (no native push yet); those without a device get a link
 * the manager shares by hand.
 */

type Step = 'loading' | 'review' | 'confirm' | 'done' | 'error';

const andList = (names: string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function changeText(row: PublishDiffRow, first: boolean): string {
  return row.changes
    .map((c) => {
      const day = shortDay(c.date);
      if (first || c.before === null) return `${day} ${c.after ?? 'removed'}`;
      return `${day} · ${c.before} → ${c.after ?? 'removed'}`;
    })
    .join(' · ');
}

export function PublishFlow(props: {
  week: WeekDocDto;
  venueName: string | null;
  online: boolean;
  preview: () => Promise<PublishPreviewDto>;
  publish: (p: PublishPreviewDto) => Promise<PublishResult>;
  onPublished: () => void;
  onClose: () => void;
  onNextWeek: () => void;
  onFindCover: (date: string, departmentId: string) => void;
}) {
  const { week, venueName, online, onPublished, onClose, onNextWeek, onFindCover } = props;
  const [step, setStep] = useState<Step>('loading');
  const [data, setData] = useState<PublishPreviewDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Extract<PublishResult, { result: 'ok' }> | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const { preview, publish } = props;

  const days = weekDays(week.weekStart);
  const range = weekRangeLabel(days[0]!, days[6]!);
  const nameOf = (id: string) => week.people.find((p) => p.id === id)?.fullName.split(/\s+/)[0] ?? 'Someone';

  const load = useCallback(
    async (message: string | null) => {
      setStep('loading');
      setError(null);
      try {
        const p = await preview();
        setData(p);
        setNotice(message);
        setStep('review');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not prepare the publish preview.');
        setStep('error');
      }
    },
    [preview],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const confirm = async () => {
    if (!data || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await publish(data);
      if (r.result === 'ok') {
        setDone(r);
        setStep('done');
        onPublished();
      } else if (r.result === 'fingerprint_mismatch') {
        setData(r.preview);
        setNotice('The week changed while you were reviewing. Here is the updated list.');
        setStep('review');
      } else if (r.result === 'version_conflict') {
        await load('Someone else changed this week while you were reviewing. Here is the updated list.');
      } else {
        setError(r.message);
        setStep('review');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not publish the week.');
    } finally {
      setBusy(false);
    }
  };

  const urgent = data?.rows.filter((r) => r.changes.some((c) => c.urgent)) ?? [];

  if (step === 'loading' || step === 'error' || !data) {
    return (
      <Dialog title="Publish" eyebrow={range} onClose={onClose} width="lg">
        {step === 'error' ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <button type="button" onClick={() => void load(null)} className={cn(btn.base, btn.plain)}>
              Try again
            </button>
          </div>
        ) : (
          <div className="space-y-2" aria-busy="true">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-xl bg-surface-raised motion-reduce:animate-none" />
            ))}
          </div>
        )}
      </Dialog>
    );
  }

  if (step === 'done' && done) {
    const noDevice = done.noDeviceUserIds.map(nameOf);
    const link = `${window.location.origin}/scheduling?week=${week.weekStart}`;
    return (
      <Dialog title="Published" eyebrow={range} onClose={onClose} width="md">
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 aria-hidden="true" className="mt-1 h-7 w-7 shrink-0 text-success" />
            <div>
              <p className="text-sm font-semibold">
                {range} · {new Date(done.publishedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              </p>
              <p className="text-sm text-muted-foreground">
                {plural(done.notifiedCount, 'person', 'people')} told in the app.
                {noDevice.length > 0 && ` ${andList(noDevice)} ${noDevice.length === 1 ? 'doesn’t' : 'don’t'} have the app yet.`}
              </p>
            </div>
          </div>
          {noDevice.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border-strong bg-surface-raised p-3 text-sm">
              <span>Share the rota link with {andList(noDevice)}</span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(link).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  );
                }}
                className={cn(btn.base, btn.sm, btn.plain)}
              >
                <Link2 aria-hidden="true" className="h-4 w-4" /> {copied ? 'Copied' : 'Copy link'}
              </button>
            </div>
          )}
          {urgent.map((r) => (
            <p key={r.userId} className="flex items-start gap-2 rounded-xl border border-[color-mix(in_oklab,var(--rota-ochre)_55%,transparent)] p-3 text-sm">
              <PhoneCall aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--rota-ochre)]" />
              {r.fullName.split(/\s+/)[0]}’s shift starts in under 24 h. They get an in-app notice now; call them too.
            </p>
          ))}
          {data.uncovered.map((u) => (
            <div key={`${u.date}-${u.departmentId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[color-mix(in_oklab,var(--rota-ochre)_45%,transparent)] p-3 text-sm">
              <span>
                {u.departmentName} · {fullDate(u.date).split(' ')[0]} still needs {u.short}
              </span>
              <button type="button" onClick={() => onFindCover(u.date, u.departmentId)} className={cn(btn.base, btn.sm, btn.plain)}>
                Find cover
              </button>
            </div>
          ))}
          <div className="grid grid-cols-2 gap-2">
            <button type="button" data-autofocus onClick={onClose} className={cn(btn.base, btn.gold)}>
              Back to week
            </button>
            <button type="button" onClick={onNextWeek} className={cn(btn.base, btn.ghost)}>
              Go to next week
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  const noDevice = data.noDeviceUserIds.map(nameOf);
  const inApp = Math.max(0, data.notifiedCount - data.noDeviceUserIds.length);

  if (step === 'confirm') {
    return (
      <Dialog title={`${fullDate(days[0]!).replace(/ \d{4}$/, '')} – ${fullDate(days[6]!)}`} eyebrow="Confirm · publish week" onClose={() => setStep('review')} width="sm" dismissable={false} hideClose>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="grid h-10 w-10 place-items-center rounded-full border border-accent/50 text-sm font-bold text-accent">
              {initialsOf(venueName ?? 'Venue').charAt(0)}
            </span>
            <div>
              <p className="text-base font-semibold">{venueName ?? 'This venue'}</p>
              <p className="text-xs text-muted-foreground">All departments · {plural(week.people.filter((p) => p.isActive).length, 'person', 'people')}</p>
            </div>
          </div>
          <div className="space-y-1 text-sm">
            <p className={cn(DISPLAY, 'text-xl')}>
              {plural(data.changeCount, 'change')} · {plural(data.notifiedCount, 'person', 'people')} told now
            </p>
            <p className="text-muted-foreground">
              {inApp} in-app{data.noDeviceUserIds.length ? `, ${data.noDeviceUserIds.length} by link` : ''}
            </p>
            {data.uncovered.length > 0 && <p className="text-warning">{plural(data.uncovered.reduce((n, u) => n + u.short, 0), 'shift')} still uncovered</p>}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <button type="button" data-autofocus onClick={() => void confirm()} disabled={!online || busy} className={cn(btn.base, btn.gold, btn.lg, 'w-full')}>
            {busy ? 'Publishing…' : 'Publish and notify'}
          </button>
          {!online && <OfflineActionNotice />}
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setStep('review')} disabled={busy} className={cn(btn.base, btn.plain)}>
              Edit
            </button>
            <button type="button" onClick={onClose} disabled={busy} className={cn(btn.base, btn.ghost)}>
              Cancel
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  const rows = showAll ? data.rows : data.rows.slice(0, 8);
  return (
    <Dialog
      title={`${plural(data.changeCount, 'change')} · ${plural(data.notifiedCount, 'person', 'people')} will be told`}
      eyebrow="Publish · step 1 of 2"
      onClose={onClose}
      width="lg"
      footer={
        <>
          <button type="button" onClick={onClose} className={cn(btn.base, btn.ghost)}>
            Back to week
          </button>
          <button type="button" onClick={() => setStep('confirm')} disabled={data.changeCount === 0 || !online} className={cn(btn.base, btn.gold)}>
            Continue
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {range} · {data.firstPublish ? 'first publish of this week' : 'changes since the last publish'}
          {data.uncovered.length > 0 && ` · ${plural(data.uncovered.reduce((n, u) => n + u.short, 0), 'shift')} still uncovered`}
        </p>
        {notice && (
          <p role="status" className="rounded-xl border border-accent/40 bg-accent/10 p-3 text-sm">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {data.changeCount === 0 && <p className="text-sm text-muted-foreground">Nothing has changed since the last publish.</p>}
        <ul className="grid gap-2 lg:grid-cols-2">
          {rows.map((r) => {
            const isUrgent = r.changes.some((c) => c.urgent);
            return (
              <li key={r.userId} className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface-raised p-3">
                <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border-strong bg-surface text-xs font-bold">
                  {initialsOf(r.fullName)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{r.fullName}</p>
                  <p className="text-xs text-muted-foreground">{changeText(r, data.firstPublish)}</p>
                </div>
                <span
                  className={cn(
                    'shrink-0 rounded-full border px-[7px] py-px text-[10px] font-bold uppercase tracking-[0.06em]',
                    isUrgent ? 'border-[color-mix(in_oklab,var(--rota-ochre)_55%,transparent)] text-[var(--rota-ochre)]' : 'border-accent/55 text-accent',
                  )}
                >
                  {isUrgent ? 'Urgent' : data.firstPublish ? `${r.changes.length} new` : plural(r.changes.length, 'change')}
                </span>
                {r.hasDevice ? (
                  <Bell aria-label="Told in the app" className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Link2 aria-label="No app yet: you get a link to share" className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
              </li>
            );
          })}
          {data.uncovered.map((u) => (
            <li key={`${u.date}-${u.departmentId}`} className="flex min-w-0 items-center gap-3 rounded-xl border border-[color-mix(in_oklab,var(--rota-ochre)_45%,transparent)] p-3">
              <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-dashed border-[var(--rota-ochre)] text-xs font-bold text-[var(--rota-ochre)]">
                !
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-[var(--rota-ochre)]">Still uncovered</p>
                <p className="text-xs text-muted-foreground">
                  {shortDay(u.date)} · {u.departmentName} needs {u.short} more
                </p>
              </div>
              <span className="shrink-0 rounded-full border border-[color-mix(in_oklab,var(--rota-ochre)_55%,transparent)] px-[7px] py-px text-[10px] font-bold uppercase tracking-[0.06em] text-[var(--rota-ochre)]">Open</span>
            </li>
          ))}
        </ul>
        {data.rows.length > 8 && !showAll && (
          <button type="button" onClick={() => setShowAll(true)} className={cn(btn.base, btn.ghost, 'w-full')}>
            Show {plural(data.rows.length - 8, 'more person', 'more people')}
          </button>
        )}
        {noDevice.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {andList(noDevice)} {noDevice.length === 1 ? 'has' : 'have'} no device yet: you get a link to share.
          </p>
        )}
        {urgent.length > 0 && (
          <p className="text-sm text-warning">
            {andList(urgent.map((r) => r.fullName.split(/\s+/)[0]!))}: a change inside 24 h of the shift. The notice alone is not enough; call them too.
          </p>
        )}
        {!online && <OfflineActionNotice />}
      </div>
    </Dialog>
  );
}
