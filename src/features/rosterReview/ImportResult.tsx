import type { ReactNode } from 'react';
import type { ConfirmResponse } from '../../api/schedules';
import { formatDay, formatWeekLabel, importResultLines } from './reviewModel';

/** After confirm: who was added or matched, what was already on the rota, what overlapped. */
export function ImportResult({ result, actions, title = 'Your team is in.' }: { result: ConfirmResponse; actions: ReactNode; title?: string | null }) {
  const lines = importResultLines(result);
  const created = result.people.filter((p) => p.outcome === 'created');
  return (
    <section className="flex flex-col gap-4 motion-safe:animate-rise" role="status" data-testid="rr-result">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-foreground/45">Imported{result.weekStart ? ` · ${formatWeekLabel(result.weekStart)}` : ''}</p>
        {title && <h3 className="mt-1 text-xl font-semibold tracking-tight text-foreground">{title}</h3>}
      </div>
      <ul className="space-y-1.5" data-testid="rr-result-lines">
        {lines.map((line) => (
          <li key={line} className="flex gap-2.5 text-sm text-foreground/80">
            <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            {line}
          </li>
        ))}
      </ul>
      {created.length > 0 && (
        <div className="rounded-2xl border border-border bg-surface p-3">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-foreground/50">New on your staff</p>
          <p className="mt-1.5 text-sm leading-relaxed text-foreground/80">{created.map((p) => p.name).join(', ')}</p>
        </div>
      )}
      {result.overlaps.length > 0 && (
        <div className="rounded-2xl border border-warning/40 bg-surface p-3">
          <p className="text-sm font-semibold text-foreground">Not added: these overlap a shift already on the rota</p>
          <ul className="mt-1.5 space-y-1 text-xs text-foreground/70">
            {result.overlaps.map((o, i) => (
              <li key={`${o.personKey}-${i}`}>
                {o.name} · {formatDay(o.date, false)} {o.startTime}–{o.endTime} (already working {o.existing.startTime}–{o.existing.endTime})
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap gap-2">{actions}</div>
    </section>
  );
}
