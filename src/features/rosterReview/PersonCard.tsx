import { useState } from 'react';
import type { PersonPreview, PreviewRow } from '../../api/schedules';
import { cn } from '../../lib/utils';
import { formatDay, personNotes, possibleMatchQuestion, shiftSummary, timeQuestions, type PersonChoice } from './reviewModel';
import { RolePicker, SelectBox } from './ui';
import { btnGhost, inputClass, segmentClass } from './styles';

export interface PersonCardProps {
  person: PersonPreview;
  rows: PreviewRow[];
  choice: PersonChoice;
  /** The preselection, restored when the manager goes back to "Same person". */
  initial: PersonChoice;
  /** The role this person's shifts get right now (assigned, from the roster, or the placeholder). */
  roleName: string;
  /** The role without anything assigned on this screen (what "keep" goes back to). */
  baseRoleName: string;
  /** True when roleName is the "Team member" placeholder because no role resolved. */
  rolePlaceholder: boolean;
  roleOptions: string[];
  selected: boolean;
  onToggleSelect: () => void;
  onChange: (next: PersonChoice) => void;
  /** Present when the same name is on the roster more than once. */
  duplicate: { separate: boolean; onSeparate: (separate: boolean) => void } | null;
  timePicks: Record<number, number>;
  onPickTime: (rowNumber: number, option: number) => void;
}

function StatusPill({ person, choice }: { person: PersonPreview; choice: PersonChoice }) {
  const [label, tone] =
    choice.action === 'skip'
      ? ['Not importing', 'border-border text-foreground/45']
      : choice.undecided
        ? ['Same person?', 'border-accent/50 bg-accent/10 text-accent']
        : person.status === 'needs_decision'
          ? ['Check', 'border-accent/50 bg-accent/10 text-accent']
          : choice.action === 'link'
            ? ['On staff', 'border-success/40 text-success']
            : ['New', 'border-foreground/20 text-foreground/75'];
  return <span className={cn('shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-wide', tone)}>{label}</span>;
}

/** One person on the roster: who they are, what the readers flagged, and the manager's decision. */
export function PersonCard({
  person,
  rows,
  choice,
  initial,
  roleName,
  baseRoleName,
  rolePlaceholder,
  roleOptions,
  selected,
  onToggleSelect,
  onChange,
  duplicate,
  timePicks,
  onPickTime,
}: PersonCardProps) {
  const [open, setOpen] = useState(false);
  const skipped = choice.action === 'skip';
  const match = possibleMatchQuestion(person);
  const notes = personNotes(person, rows);
  const questions = timeQuestions(rows);
  const detailsId = `rr-details-${person.personKey}`;
  const displayName = choice.action === 'create' ? choice.name || person.name : person.name;
  // Linked to someone whose name differs from the roster's ("Bast" -> Bastian Rao): say who.
  const linkedTo = choice.action === 'link' && choice.userId !== person.matchedUserId ? match?.candidates.find((c) => c.userId === choice.userId)?.fullName : undefined;

  return (
    <li
      data-testid="rr-person"
      data-person-status={person.status}
      className={cn(
        'rounded-2xl border bg-surface transition-[border-color,opacity] duration-200',
        person.status === 'needs_decision' && !skipped ? 'border-accent/35' : 'border-border',
        skipped && 'opacity-60',
      )}
    >
      <div className="flex items-start gap-1 p-2 pr-3">
        <SelectBox checked={selected} onToggle={onToggleSelect} label={`Select ${person.name}`} />
        <div className="min-w-0 flex-1 py-1.5">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate text-[15px] font-semibold leading-snug text-foreground" title={displayName}>
              {displayName}
            </p>
            <StatusPill person={person} choice={choice} />
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-foreground/60">
            <span className={cn(rolePlaceholder && !skipped && 'text-warning')}>{roleName}</span>
            <span aria-hidden>·</span>
            <span>{shiftSummary(rows)}</span>
            {person.section && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate text-foreground/45">{person.section}</span>
              </>
            )}
          </p>
          {linkedTo && <p className="mt-1 text-xs text-foreground/70">Same person as {linkedTo}</p>}
          {rolePlaceholder && !skipped && (
            <p className="mt-1 text-xs text-foreground/60">
              {person.roleLabel ? `Role “${person.roleLabel}” isn't set up here yet` : 'No role on the roster'} — assign one, or they join as Team member.
            </p>
          )}
        </div>
      </div>

      {!skipped && (match || duplicate || questions.length > 0 || notes.length > 0) && (
        <div className="space-y-3 border-t border-border/70 px-3 py-3">
          {match && (
            <div>
              <p className="text-sm text-foreground/85">{match.text}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {match.candidates.map((c) => {
                  const on = !choice.undecided && choice.action === 'link' && choice.userId === c.userId;
                  return (
                    <button
                      key={c.userId}
                      type="button"
                      aria-pressed={on}
                      className={segmentClass(on)}
                      onClick={() => onChange({ ...choice, action: 'link', userId: c.userId, undecided: false })}
                    >
                      {match.candidates.length === 1 ? 'Same person' : c.fullName}
                    </button>
                  );
                })}
                <button
                  type="button"
                  aria-pressed={!choice.undecided && choice.action === 'create'}
                  className={segmentClass(!choice.undecided && choice.action === 'create')}
                  onClick={() => onChange({ ...choice, action: 'create', userId: null, undecided: false })}
                >
                  New person
                </button>
              </div>
            </div>
          )}

          {duplicate && (
            <div>
              <p className="text-sm text-foreground/85">Same person both times?</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-pressed={!duplicate.separate}
                  className={segmentClass(!duplicate.separate)}
                  onClick={() => {
                    duplicate.onSeparate(false);
                    onChange({ ...initial, roleName: choice.roleName });
                  }}
                >
                  Same person
                </button>
                <button
                  type="button"
                  aria-pressed={duplicate.separate}
                  className={segmentClass(duplicate.separate)}
                  onClick={() => {
                    duplicate.onSeparate(true);
                    onChange({ ...choice, action: 'create', userId: null });
                  }}
                >
                  Two people
                </button>
              </div>
              {duplicate.separate && (
                <label className="mt-2 block">
                  <span className="text-xs text-foreground/60">Name this one so you can tell them apart</span>
                  <input className={cn(inputClass, 'mt-1')} value={choice.name} maxLength={120} onChange={(e) => onChange({ ...choice, name: e.target.value })} />
                </label>
              )}
            </div>
          )}

          {questions.map((q) => (
            <div key={q.rowNumber}>
              <p className="text-sm text-foreground/85">{q.text}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {q.options.map((o, i) => (
                  <button
                    key={o.label}
                    type="button"
                    aria-pressed={(timePicks[q.rowNumber] ?? 0) === i}
                    className={segmentClass((timePicks[q.rowNumber] ?? 0) === i)}
                    onClick={() => onPickTime(q.rowNumber, i)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          ))}

          {notes.length > 0 && (
            <ul className="space-y-1">
              {notes.map((n) => (
                <li key={n.key} className={cn('flex gap-2 text-xs', n.tone === 'check' ? 'text-warning' : 'text-foreground/55')}>
                  <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-current" />
                  {n.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="border-t border-border/70">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          className="flex min-h-11 w-full items-center justify-between px-3 text-xs font-medium uppercase tracking-[0.14em] text-foreground/50 hover:text-foreground/80"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide details' : 'Shifts, name & role'}
          <svg
            aria-hidden
            width={12}
            height={12}
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.2}
            strokeLinecap="round"
            className={cn('motion-safe:transition-transform motion-safe:duration-200', open && 'rotate-180')}
          >
            <path d="M3 4.5l3 3 3-3" />
          </svg>
        </button>
        {open && (
          <div id={detailsId} className="space-y-3 px-3 pb-3">
            {rows.length > 0 ? (
              <ul className="divide-y divide-border/60 rounded-lg border border-border/70">
                {rows.map((r) => (
                  <li key={r.rowNumber} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span className="text-foreground/80">{formatDay(r.date, false)}</span>
                    <span className="tabular-nums text-foreground/65">
                      {r.startTime}–{r.endTime}
                      {r.overnight && <span className="ml-1 text-[10px] text-foreground/45">+1</span>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-foreground/60">No shifts this week. They're still added to your staff.</p>
            )}

            {choice.action === 'create' && !duplicate?.separate && (
              <label className="block">
                <span className="text-xs text-foreground/60">Name on your staff list</span>
                <input className={cn(inputClass, 'mt-1')} value={choice.name} maxLength={120} onChange={(e) => onChange({ ...choice, name: e.target.value })} />
              </label>
            )}

            <div>
              <span className="text-xs text-foreground/60">Role</span>
              <div className="mt-1">
                <RolePicker
                  label={`Role for ${person.name}`}
                  value={choice.roleName}
                  options={roleOptions}
                  keepLabel={baseRoleName}
                  onChange={(role) => onChange({ ...choice, roleName: role })}
                />
              </div>
            </div>

            <button type="button" className={btnGhost} onClick={() => onChange(skipped ? { ...initial, roleName: choice.roleName } : { ...choice, action: 'skip' })}>
              {skipped ? 'Import this person' : "Don't import this person"}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
