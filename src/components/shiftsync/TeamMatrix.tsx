import { cn } from '../../lib/utils';

export type CellKind = 'shift' | 'double' | 'off';

export interface MatrixCell {
  code: string;
  kind: CellKind;
  /** The role this shift actually needs (may differ from the assigned employee's own role after a cover). */
  requiredRole?: string;
}

export interface MatrixMember {
  id: string;
  name: string;
  role: string;
  initials: string;
}

interface TeamMatrixProps {
  venueName: string;
  days: string[];
  members: MatrixMember[];
  /** matrix[memberIndex][dayIndex] */
  matrix: MatrixCell[][];
}

const kindStyles: Record<CellKind, string> = {
  shift: 'bg-accent/15 text-accent border-accent/25',
  double: 'bg-accent text-accent-foreground border-accent',
  off: 'bg-muted text-muted-foreground border-border',
};

const legend: { label: string; kind: CellKind }[] = [
  { label: 'Shift', kind: 'shift' },
  { label: 'Double', kind: 'double' },
  { label: 'Off', kind: 'off' },
];

export function TeamMatrix({ venueName, days, members, matrix }: TeamMatrixProps) {
  return (
    <section className="panel animate-rise overflow-hidden">
      <header className="border-b border-border p-4">
        <p className="eyebrow">{venueName}</p>
        <h2 className="truncate text-lg font-semibold tracking-tight">Team Matrix</h2>
      </header>

      <div className="overflow-x-auto">
        <div className="min-w-[620px]">
          <div className="grid grid-cols-[9.5rem_repeat(7,minmax(0,1fr))] border-b border-border bg-background/40">
            <div className="p-3 eyebrow">Staff</div>
            {days.map((d) => (
              <div key={d} className="p-3 text-center text-xs font-medium text-muted-foreground">
                {d}
              </div>
            ))}
          </div>

          {members.map((member, r) => (
            <div
              key={member.id}
              className="grid grid-cols-[9.5rem_repeat(7,minmax(0,1fr))] border-b border-border/60 transition-colors last:border-0 hover:bg-surface-raised/60"
            >
              <div className="flex min-w-0 items-center gap-2.5 p-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border-strong bg-muted text-[11px] font-semibold">
                  {member.initials}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium leading-tight">
                    {member.name}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {member.role}
                  </span>
                </span>
              </div>
              {matrix[r]?.map((cell, c) => (
                <div key={c} className="p-1.5">
                  <div
                    title={cell.requiredRole}
                    className={cn(
                      'grid h-10 min-w-[4.5rem] place-items-center rounded-md border px-1 text-[10px] font-semibold tracking-wide transition-transform duration-200 hover:scale-[1.06]',
                      kindStyles[cell.kind],
                    )}
                  >
                    {cell.code}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border p-4">
        {legend.map((l) => (
          <span key={l.label} className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className={cn('h-3 w-3 rounded-sm border', kindStyles[l.kind])} />
            {l.label}
          </span>
        ))}
      </footer>
    </section>
  );
}
