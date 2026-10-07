import { useEffect, useMemo, useState } from 'react';
import type { ConfirmRosterRequest, UploadResponse } from '../../api/schedules';
import { fetchRoles, type RoleSummary } from '../../api/roles';
import { useIdentity } from '../../state/IdentityContext';
import { cn } from '../../lib/utils';
import { PersonCard } from './PersonCard';
import {
  addDays,
  buildConfirmRequest,
  clientNameKey,
  duplicateGroups,
  formatDay,
  formatWeekLabel,
  hardToReadNotice,
  headerLine,
  initialChoice,
  initialReviewState,
  readerLabel,
  reviewBlockers,
  reviewPeople,
  reviewWeek,
  unreadRowsOf,
  type ReviewState,
} from './reviewModel';
import { RolePicker } from './ui';
import { btnGhost, btnLink, btnPrimary, inputClass, segmentClass } from './styles';

/** Offered alongside the venue's own roles (a brand-new venue has none yet). */
const COMMON_ROLES = ['Head Waiter', 'Waiter', 'Commis Waiter', 'Host', 'Server', 'Bartender', 'Head Bartender', 'Supervisor', 'Manager'];
const TEAM_MEMBER = 'Team member';

function loadPersisted(key: string | undefined, personKeys: string[]): ReviewState | null {
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const state = JSON.parse(raw) as ReviewState;
    // Only for the same people (a different upload under a reused key starts fresh).
    return personKeys.every((k) => state.choices?.[k]) ? state : null;
  } catch {
    return null;
  }
}

export interface RosterReviewProps {
  upload: UploadResponse;
  onConfirm: (request: ConfirmRosterRequest) => void;
  confirming: boolean;
  error: string | null;
  createdById?: string | null;
  /** 'app': the sticky confirm bar clears the bottom dock; 'onboarding': it sits at the very bottom. */
  variant: 'app' | 'onboarding';
  /** sessionStorage key for in-progress decisions, so a reload keeps them. */
  persistKey?: string;
  /** Why confirming is not possible right now (offline), from the host. */
  disabledReason?: string | null;
  onDiscard?: () => void;
}

/**
 * The roster review: one card per person on the roster, the week the shifts land in, what
 * couldn't be read, and the manager's decisions. Shared by the onboarding Review step and the
 * Scheduling page import; nothing is written until Confirm.
 */
export function RosterReview({ upload, onConfirm, confirming, error, createdById, variant, persistKey, disabledReason, onDiscard }: RosterReviewProps) {
  const { session } = useIdentity();
  const people = useMemo(() => reviewPeople(upload), [upload]);
  const week = useMemo(() => reviewWeek(upload), [upload]);
  const unread = unreadRowsOf(upload);
  const rowsByNumber = useMemo(() => new Map(upload.preview.map((r) => [r.rowNumber, r])), [upload]);
  const groups = useMemo(() => duplicateGroups(people), [people]);

  const [state, setState] = useState<ReviewState>(
    () =>
      loadPersisted(
        persistKey,
        people.map((p) => p.personKey),
      ) ?? initialReviewState(people, week),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<'all' | 'check' | 'norole'>('all');
  const [bulkRole, setBulkRole] = useState<string | null>(null);
  const [changingWeek, setChangingWeek] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState('');
  const [addRole, setAddRole] = useState<string | null>(null);
  const [reviewedAnomalies, setReviewedAnomalies] = useState<Set<number>>(new Set());
  const [roles, setRoles] = useState<RoleSummary[]>([]);

  useEffect(() => {
    if (!persistKey) return;
    try {
      sessionStorage.setItem(persistKey, JSON.stringify(state));
    } catch {
      // Storage unavailable: decisions still hold for this page, they just won't survive a reload.
    }
  }, [persistKey, state]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    fetchRoles(session.token)
      .then((list) => {
        if (!cancelled) setRoles(list);
      })
      .catch(() => {
        // Best effort: the common roles still work; the venue's own just won't be listed.
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const roleNameById = useMemo(() => new Map(roles.map((r) => [r.id, r.name])), [roles]);
  const roleOptions = useMemo(() => [...new Set([...roles.map((r) => r.name), ...COMMON_ROLES])], [roles]);

  const isRoleUnresolved = (key: string) => !!people.find((p) => p.personKey === key)?.flags.some((f) => f.kind === 'role_unresolved');
  const baseRoleOf = (key: string) => {
    const person = people.find((p) => p.personKey === key)!;
    if (isRoleUnresolved(key)) return TEAM_MEMBER;
    return (person.resolvedRoleId && roleNameById.get(person.resolvedRoleId)) || person.roleLabel || 'Role on file';
  };

  const choiceOf = (key: string) => state.choices[key] ?? initialChoice(people.find((p) => p.personKey === key)!);
  const setChoice = (key: string, next: ReviewState['choices'][string]) => setState((s) => ({ ...s, choices: { ...s.choices, [key]: next } }));

  const anomalies = upload.anomalies ?? [];
  const leaveRecords = upload.leaveRecords ?? [];
  const legend = upload.legend ?? [];
  const parseIssues = upload.parseIssues ?? [];
  const anomaliesOutstanding = anomalies.length - reviewedAnomalies.size;
  const blockers = reviewBlockers(people, week, state, { anomaliesOutstanding });
  // Distinct people: two entries that are the same person (listed twice) count once.
  const importing =
    new Set(
      people.flatMap((p) => {
        const c = choiceOf(p.personKey);
        if (c.action === 'skip') return [];
        return [c.action === 'link' && c.userId ? `user:${c.userId}` : `name:${clientNameKey(c.name || p.name)}`];
      }),
    ).size + state.added.length;

  const needsCheck = people.filter((p) => p.status === 'needs_decision');
  const noRole = people.filter((p) => isRoleUnresolved(p.personKey) && !choiceOf(p.personKey).roleName);
  const visible = filter === 'check' ? needsCheck : filter === 'norole' ? noRole : people;
  const counts = {
    onStaff: people.filter((p) => choiceOf(p.personKey).action === 'link').length,
    fresh: people.filter((p) => choiceOf(p.personKey).action === 'create').length + state.added.length,
  };

  const toggleSelected = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const assignBulk = () => {
    if (!bulkRole) return;
    setState((s) => {
      const choices = { ...s.choices };
      for (const key of selected) choices[key] = { ...choiceOf(key), roleName: bulkRole };
      return { ...s, choices };
    });
    setSelected(new Set());
    setBulkRole(null);
  };

  const addPerson = () => {
    const name = addName.trim();
    if (!name) return;
    setState((s) => ({ ...s, added: [...s.added, { name, roleName: addRole }] }));
    setAddName('');
    setAddRole(null);
    setAdding(false);
  };

  const moveWeek = (weeks: number) => setState((s) => (s.weekStart ? { ...s, weekStart: addDays(s.weekStart, weeks * 7), weekConfirmed: true } : s));

  const confirm = () => {
    if (blockers.length > 0 || confirming || disabledReason) return;
    onConfirm(buildConfirmRequest(people, upload.preview, state, { createdById }));
  };

  return (
    <div className="flex flex-col gap-4" data-testid="roster-review">
      {/* Header: people, not rows */}
      <header>
        <h3 className="text-xl font-semibold tracking-tight text-foreground" data-testid="rr-header">
          {headerLine(people.length, unread.length)}
        </h3>
        <p className="mt-1 text-sm text-foreground/60">
          {counts.onStaff} already on your staff · {counts.fresh} new
          {needsCheck.length > 0 && <span className="text-accent"> · {needsCheck.length} to check</span>}
          {noRole.length > 0 && <span className="text-warning"> · {noRole.length} without a role</span>}
        </p>
        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-foreground/50">
          {readerLabel(upload.reading) && (
            <span className="rounded-full border border-border px-2.5 py-1" data-testid="rr-reader">
              {readerLabel(upload.reading)}
            </span>
          )}
          {upload.reading?.fromCache && (
            <span className="rounded-full border border-accent/40 px-2.5 py-1 text-accent" data-testid="rr-from-cache">
              Read from previous upload
            </span>
          )}
        </div>
      </header>

      {/* A photo or scan page nothing was imported from: said plainly, with what to do */}
      {hardToReadNotice(upload.reading) && (
        <section className="rounded-2xl border border-warning/50 bg-surface p-4" role="alert" data-testid="rr-hard-to-read">
          <p className="text-sm font-semibold text-foreground">Hard to read — not imported</p>
          <p className="mt-1 text-sm text-foreground/75">{hardToReadNotice(upload.reading)!.text}</p>
        </section>
      )}

      {/* Week */}
      {week && state.weekStart && (
        <section
          data-testid="rr-week"
          className={cn('rounded-2xl border bg-surface p-4', week.needsConfirmation && !state.weekConfirmed ? 'border-accent/50' : 'border-border')}
        >
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-foreground/45">Shifts go into</p>
          <div className="mt-1 flex items-center justify-between gap-2">
            <p className="text-base font-semibold text-foreground">{formatWeekLabel(state.weekStart)}</p>
            {!changingWeek && !(week.needsConfirmation && !state.weekConfirmed) && (
              <button type="button" className={btnLink} onClick={() => setChangingWeek(true)}>
                Change
              </button>
            )}
          </div>
          {week.printedLabel && <p className="mt-0.5 text-xs text-foreground/55">Printed on the roster: {week.printedLabel}</p>}
          {state.weekStart !== week.weekStart && (
            <p className="mt-0.5 text-xs text-warning">Moved from the {formatWeekLabel(week.weekStart).toLowerCase()} the roster is dated in.</p>
          )}
          {week.needsConfirmation && !state.weekConfirmed && week.reason && <p className="mt-2 text-sm text-foreground/75">{week.reason}</p>}
          {(changingWeek || (week.needsConfirmation && !state.weekConfirmed)) && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" className={btnGhost} aria-label="Previous week" onClick={() => moveWeek(-1)}>
                ‹ Earlier
              </button>
              <button type="button" className={btnGhost} aria-label="Next week" onClick={() => moveWeek(1)}>
                Later ›
              </button>
              <button
                type="button"
                className={btnPrimary}
                data-testid="rr-week-confirm"
                onClick={() => {
                  setState((s) => ({ ...s, weekConfirmed: true }));
                  setChangingWeek(false);
                }}
              >
                Use this week
              </button>
            </div>
          )}
        </section>
      )}

      {/* What couldn't be read */}
      {unread.length > 0 && (
        <section className="rounded-2xl border border-border bg-surface p-4" data-testid="rr-unread">
          <p className="text-sm font-semibold text-foreground">
            {unread.length} {unread.length === 1 ? "row couldn't" : "rows couldn't"} be read
          </p>
          <p className="mt-0.5 text-xs text-foreground/55">Add anyone missing below, or fix the file and upload it again.</p>
          <ul className="mt-2 space-y-2">
            {unread.map((u, i) => (
              <li key={i} className="rounded-lg bg-background/50 px-3 py-2">
                <p className="break-words font-mono text-xs text-foreground/80">{u.text || '(blank)'}</p>
                <p className="mt-0.5 text-xs text-foreground/55">
                  {u.page !== null && `Page ${u.page} · `}
                  {u.row !== null && `Row ${u.row} · `}
                  {u.reason}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Cells the AI reader could not place */}
      {anomalies.length > 0 && (
        <section className="rounded-2xl border border-accent/35 bg-surface p-4" role="alert">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-foreground">
                {anomalies.length} unclear {anomalies.length === 1 ? 'cell' : 'cells'} to look at
              </p>
              <p className="mt-0.5 text-xs text-foreground/55">The reader couldn't place these, so they aren't in anyone's shifts. Mark each one looked at.</p>
            </div>
            <button
              type="button"
              className={btnGhost}
              disabled={anomaliesOutstanding === 0}
              onClick={() => setReviewedAnomalies(new Set(anomalies.map((_, i) => i)))}
            >
              Mark all
            </button>
          </div>
          <ul className="mt-2 space-y-2">
            {anomalies.map((a, i) => (
              <li key={i} className="flex items-start justify-between gap-2 text-xs text-foreground/75">
                <span className="min-w-0 py-2">
                  {a.employeeName ? <strong className="text-foreground">{a.employeeName}</strong> : <em>No name</em>}
                  {a.date ? ` · ${formatDay(a.date, false)}` : ''} — “{a.rawText}”: {a.reason}
                </span>
                <button
                  type="button"
                  aria-pressed={reviewedAnomalies.has(i)}
                  className={cn(segmentClass(reviewedAnomalies.has(i)), 'min-w-[6.5rem] shrink-0 whitespace-nowrap')}
                  onClick={() =>
                    setReviewedAnomalies((prev) => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                >
                  {reviewedAnomalies.has(i) ? 'Looked at' : 'Mark'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(leaveRecords.length > 0 || legend.length > 0 || parseIssues.length > 0) && (
        <details className="rounded-2xl border border-border bg-surface px-4 text-sm text-foreground/75">
          <summary className="flex min-h-11 cursor-pointer items-center text-xs font-medium uppercase tracking-[0.14em] text-foreground/50">Other notes from the reader</summary>
          <div className="space-y-3 pb-4">
            {leaveRecords.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-foreground/80">Days off and leave (not shifts)</p>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {leaveRecords.map((l, i) => (
                    <li key={i}>
                      {l.employeeName} · {formatDay(l.date, false)} — {l.leaveCode}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {legend.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-foreground/80">Shift codes</p>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {legend.map((l, i) => (
                    <li key={i}>
                      <strong>{l.code}</strong> — {l.meaning}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {parseIssues.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-foreground/80">Rows left out</p>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {parseIssues.map((issue, i) => (
                    <li key={i}>
                      Row {issue.rowNumber}: {issue.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}

      {/* Filters + bulk role */}
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ['all', `Everyone (${people.length})`],
            ['check', `To check (${needsCheck.length})`],
            ['norole', `No role (${noRole.length})`],
          ] as const
        ).map(([key, label]) => (
          <button key={key} type="button" aria-pressed={filter === key} className={segmentClass(filter === key)} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
        {noRole.length > 0 && (
          <button type="button" className={btnLink} onClick={() => setSelected(new Set(noRole.map((p) => p.personKey)))}>
            Select everyone without a role
          </button>
        )}
      </div>

      {selected.size > 0 && (
        <section className="rounded-2xl border border-accent/40 bg-surface-raised p-3" data-testid="rr-bulk">
          <p className="text-sm font-medium text-foreground">{selected.size} selected</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <div className="flex-1">
              <RolePicker label="Role for the selected people" value={bulkRole} options={roleOptions} keepLabel="Choose a role…" onChange={setBulkRole} />
            </div>
            <button type="button" className={btnPrimary} disabled={!bulkRole} onClick={assignBulk} data-testid="rr-bulk-assign">
              Assign role to selected
            </button>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-foreground/75">
              <input
                type="checkbox"
                className="h-5 w-5 accent-[var(--accent)]"
                checked={state.rememberRoles}
                onChange={(e) => setState((s) => ({ ...s, rememberRoles: e.target.checked }))}
              />
              Remember for next time
            </label>
            <button type="button" className={btnLink} onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        </section>
      )}

      {/* People */}
      <ul className="flex flex-col gap-2.5" aria-label="People on this roster">
        {visible.map((person) => {
          const key = person.personKey;
          const choice = choiceOf(key);
          const base = baseRoleOf(key);
          const group = groups.get(key);
          return (
            <PersonCard
              key={key}
              person={person}
              rows={person.rowNumbers.map((n) => rowsByNumber.get(n)).filter((r): r is NonNullable<typeof r> => !!r)}
              choice={choice}
              initial={initialChoice(person)}
              roleName={choice.roleName ?? base}
              baseRoleName={base}
              rolePlaceholder={!choice.roleName && isRoleUnresolved(key)}
              roleOptions={roleOptions}
              selected={selected.has(key)}
              onToggleSelect={() => toggleSelected(key)}
              onChange={(next) => setChoice(key, next)}
              duplicate={
                group && group[0] !== key
                  ? {
                      separate: state.separate.includes(key),
                      onSeparate: (separate) =>
                        setState((s) => ({ ...s, separate: separate ? [...new Set([...s.separate, key])] : s.separate.filter((k) => k !== key) })),
                    }
                  : null
              }
              timePicks={state.timePicks}
              onPickTime={(rowNumber, option) => setState((s) => ({ ...s, timePicks: { ...s.timePicks, [rowNumber]: option } }))}
            />
          );
        })}
        {visible.length === 0 && <li className="rounded-2xl border border-dashed border-border p-4 text-sm text-foreground/55">Nobody here.</li>}
      </ul>

      {/* Added by hand */}
      {state.added.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="People you added">
          {state.added.map((a, i) => (
            <li key={`${a.name}-${i}`} className="flex items-center justify-between gap-2 rounded-2xl border border-border bg-surface py-1 pl-4 pr-1">
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold text-foreground">{a.name}</p>
                <p className="text-xs text-foreground/60">{a.roleName ?? TEAM_MEMBER} · added by you · no shifts yet</p>
              </div>
              <button type="button" className={btnLink} onClick={() => setState((s) => ({ ...s, added: s.added.filter((_, j) => j !== i) }))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <section className="rounded-2xl border border-border bg-surface p-3" data-testid="rr-add-form">
          <p className="text-sm font-medium text-foreground">Add someone the roster missed</p>
          <div className="mt-2 flex flex-col gap-2">
            <input
              aria-label="Name"
              className={inputClass}
              placeholder="Full name"
              value={addName}
              maxLength={120}
              autoFocus
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addPerson();
                }
              }}
            />
            <RolePicker label="Role for the added person" value={addRole} options={roleOptions} keepLabel={`Role: ${TEAM_MEMBER}`} onChange={setAddRole} />
            <div className="flex gap-2">
              <button type="button" className={btnPrimary} disabled={!addName.trim()} onClick={addPerson}>
                Add
              </button>
              <button type="button" className={btnGhost} onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </div>
        </section>
      ) : (
        <button type="button" className={cn(btnGhost, 'w-full border-dashed')} onClick={() => setAdding(true)} data-testid="rr-add-person">
          + Add missing person
        </button>
      )}

      {/* Confirm */}
      <div
        className={cn(
          'sticky z-10 -mx-1 flex flex-col gap-2 rounded-2xl border border-border bg-surface-raised/95 p-3 shadow-lux backdrop-blur',
          variant === 'app' ? 'bottom-[calc(4.75rem+env(safe-area-inset-bottom))]' : 'bottom-3',
        )}
      >
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <p className="text-xs text-foreground/60" data-testid="rr-status">
          {disabledReason ?? blockers[0] ?? "Nothing is saved until you confirm. Everyone you import is added to your staff."}
        </p>
        <div className="flex gap-2">
          {onDiscard && (
            <button type="button" className={btnGhost} onClick={onDiscard}>
              Discard
            </button>
          )}
          <button
            type="button"
            className={cn(btnPrimary, 'flex-1')}
            disabled={blockers.length > 0 || confirming || !!disabledReason}
            onClick={confirm}
            data-testid="rr-confirm"
          >
            {confirming ? 'Importing…' : `Confirm ${importing} ${importing === 1 ? 'person' : 'people'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
