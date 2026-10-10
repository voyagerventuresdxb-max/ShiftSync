import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { applyRotaTemplate, deleteRotaTemplate, fetchRotaTemplates, saveRotaTemplate, type RotaTemplateDto, type TemplateEntryInput } from '@/api/rotaTemplates';
import { OfflineActionNotice } from '@/components/shiftsync/OfflineNotice';
import { weekDays, type IsoDate, type WeekDocDto, type WeekPatchOp } from '../../../shared/rotaWeek';
import { planCopy, replaceableCount, type PlanEntry } from '@/engine/rotaPlans';
import { Dialog, btn } from './Dialog';

/**
 * Templates (Design board B5): save this week as shift types per person per
 * weekday (not dates), and load one back like Copy last week — fill or
 * replace, all departments or one. People who have left are dropped on
 * load; new people simply have empty rows. Applying is ONE patch and one
 * undo step. A server that does not yet return template entries gets its
 * own apply endpoint instead (all departments, onto empty cells).
 */

const field =
  'min-h-11 w-full min-w-0 rounded-xl border border-border-strong bg-background/60 px-3 text-sm text-foreground focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-ring';

function templateEntriesOf(week: WeekDocDto): TemplateEntryInput[] {
  const days = weekDays(week.weekStart);
  return week.shifts
    .filter((s) => s.roleId && days.includes(s.date) && s.ranges.length > 0)
    .map((s) => ({
      dayOffset: days.indexOf(s.date),
      roleId: s.roleId,
      userId: s.userId,
      start: s.ranges[0]!.start,
      end: s.ranges[0]!.end,
      ...(s.note ? { note: s.note } : {}),
      shiftTypeId: s.shiftTypeId,
      ranges: s.ranges,
      departmentId: s.departmentId,
    }));
}

function planEntries(entries: TemplateEntryInput[]): PlanEntry[] {
  return entries.map((e) => ({
    dayOffset: e.dayOffset,
    userId: e.userId,
    roleId: e.roleId || null,
    departmentId: e.departmentId ?? null,
    shiftTypeId: e.shiftTypeId ?? null,
    ranges: e.ranges && e.ranges.length > 0 ? e.ranges : [{ start: e.start, end: e.end }],
    note: e.note ?? null,
  }));
}

export function TemplatesDialog(props: {
  week: WeekDocDto;
  locationId: string;
  token: string;
  actorId: string;
  today: IsoDate;
  online: boolean;
  onApply: (ops: WeekPatchOp[], label: string) => Promise<boolean>;
  /** The server applied the template itself (legacy path): refetch and say so. */
  onServerApplied: (message: string) => void;
  onClose: () => void;
}) {
  const { week, locationId, token, actorId, today, online, onApply, onServerApplied, onClose } = props;
  const [templates, setTemplates] = useState<RotaTemplateDto[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [mode, setMode] = useState<'fill' | 'replace'>('fill');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRotaTemplates(token, locationId)
      .then((list) => !cancelled && setTemplates(list))
      .catch((err) => {
        if (cancelled) return;
        setTemplates([]);
        setError(err instanceof Error ? err.message : 'Could not load templates.');
      });
    return () => {
      cancelled = true;
    };
  }, [token, locationId]);

  const template = templates?.find((t) => t.id === selected) ?? null;
  const plan = useMemo(
    () => (template?.entries ? planCopy({ target: week, entries: planEntries(template.entries), mode, today, departmentId, missingPerson: 'drop' }) : null),
    [template, week, mode, today, departmentId],
  );
  const saveable = templateEntriesOf(week);

  const guard = async (fn: () => Promise<void>) => {
    if (busy || !online) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const apply = () =>
    guard(async () => {
      if (!template) return;
      if (plan) {
        const ok = await onApply(plan.ops, `Applied “${template.name}” (${plan.created})`);
        if (ok) onClose();
        return;
      }
      const r = await applyRotaTemplate(token, template.id, week.weekStart, actorId);
      onServerApplied(`Applied “${template.name}” — ${r.createdCount} shifts created.`);
      onClose();
    });

  const save = () =>
    guard(async () => {
      const n = name.trim();
      if (!n) return;
      const t = await saveRotaTemplate(token, n, saveable, actorId);
      setTemplates((prev) => [t, ...(prev ?? [])]);
      setName('');
      setStatus(`Saved “${t.name}” — ${saveable.length} shifts.`);
    });

  const remove = (id: string) =>
    guard(async () => {
      await deleteRotaTemplate(token, id);
      setTemplates((prev) => (prev ?? []).filter((t) => t.id !== id));
      if (selected === id) setSelected(null);
    });

  return (
    <Dialog title="Templates" eyebrow="Rota" onClose={onClose} width="md" dismissable={!busy}>
      <div className="space-y-4">
        <div>
          <p className="eyebrow mb-1.5">Saved · {templates?.length ?? '…'}</p>
          {templates === null ? (
            <div className="h-12 animate-pulse rounded-xl bg-surface-raised motion-reduce:animate-none" />
          ) : templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No templates yet. Save this week below to reuse it.</p>
          ) : (
            <ul className="space-y-1.5">
              {templates.map((t) => (
                <li key={t.id} className={cn('flex items-center gap-2 rounded-xl border p-2.5 ps-3', selected === t.id ? 'border-accent bg-accent/10' : 'border-border bg-surface-raised')}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{t.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.entryCount} shifts · saved {new Date(t.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </p>
                  </div>
                  <button type="button" onClick={() => setSelected(t.id)} className={cn(btn.base, btn.sm, btn.plain)}>
                    Load
                  </button>
                  <button type="button" onClick={() => void remove(t.id)} disabled={!online || busy} aria-label={`Delete template ${t.name}`} className={cn(btn.base, btn.sm, btn.ghost, 'w-9 px-0')}>
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {template && (
          <div className="space-y-3 rounded-2xl border border-border-strong bg-surface-raised p-3.5">
            <p className="eyebrow text-accent">Apply “{template.name}” to</p>
            {template.entries ? (
              <>
                <div role="radiogroup" aria-label="Departments" className="flex flex-wrap gap-1.5">
                  {[{ id: null as string | null, name: 'All departments' }, ...week.departments.map((d) => ({ id: d.id as string | null, name: `${d.name} only` }))].map((d) => (
                    <button
                      key={d.id ?? 'all'}
                      type="button"
                      role="radio"
                      aria-checked={departmentId === d.id}
                      onClick={() => setDepartmentId(d.id)}
                      className={cn(btn.base, btn.sm, departmentId === d.id ? 'border-accent bg-accent/10 text-foreground' : btn.plain)}
                    >
                      {d.name}
                    </button>
                  ))}
                </div>
                <div className="space-y-1.5">
                  {(
                    [
                      ['fill', 'Fill empty cells only'],
                      ['replace', `Replace · ${replaceableCount(week, today, departmentId)} shifts overwritten`],
                    ] as const
                  ).map(([value, text]) => (
                    <label key={value} className={cn('flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 text-sm', mode === value ? 'border-accent bg-accent/10' : 'border-border-strong bg-surface')}>
                      <input type="radio" name="template-mode" checked={mode === value} onChange={() => setMode(value)} className="accent-[var(--accent)]" />
                      {text}
                    </label>
                  ))}
                </div>
                {plan && (
                  <p className="text-xs text-muted-foreground">
                    {plan.created} shifts placed
                    {plan.keptExisting ? ` · ${plan.keptExisting} cells kept` : ''}
                    {plan.attention.length ? ` · ${plan.attention.reduce((n, a) => n + a.count, 0)} become open shifts (leave or requests)` : ''}
                    {plan.dropped ? ` · ${plan.dropped} dropped (people who left)` : ''}
                    {plan.skippedPast ? ` · ${plan.skippedPast} on past days skipped` : ''}
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">This template is applied by the server as saved: all departments, onto empty cells. If someone already has a shift on one of its days, nothing is applied and you are told which.</p>
            )}
            <button type="button" onClick={() => void apply()} disabled={!online || busy || (plan !== null && plan.ops.length === 0)} className={cn(btn.base, btn.gold, 'w-full')}>
              {busy ? 'Applying…' : plan ? `Apply ${plan.created} shifts` : 'Apply template'}
            </button>
          </div>
        )}

        <div className="space-y-1.5 border-t border-border pt-4">
          <label htmlFor="template-name" className="eyebrow block">
            Save this week as a template
          </label>
          <div className="flex gap-2">
            <input id="template-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Standard week" className={field} />
            <button type="button" onClick={() => void save()} disabled={!online || busy || !name.trim() || saveable.length === 0} className={cn(btn.base, btn.plain)}>
              Save
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Saves {saveable.length} shift{saveable.length === 1 ? '' : 's'} as types per person per weekday, not dates.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {status && (
          <p role="status" className="text-sm text-success">
            {status}
          </p>
        )}
        {!online && <OfflineActionNotice />}
      </div>
    </Dialog>
  );
}
