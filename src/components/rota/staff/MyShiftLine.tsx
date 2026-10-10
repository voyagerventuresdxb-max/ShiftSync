import { formatShiftDate } from '../../../state/useMyShifts';
import { myShiftLabels } from './myShiftLabels';
import type { MyShiftEntry } from '../../../api/myShifts';

/**
 * One my-shifts line: "Sat 10 Oct · Evening · Waiter · 16:00–01:00 +1" and
 * the note under it. The times keep their test id and their exact old text
 * ("17:00–23:00") for a single-range shift.
 */
export function ShiftLine({ shift, testId, className }: { shift: MyShiftEntry; testId: string; className?: string }) {
  const l = myShiftLabels(shift);
  return (
    <>
      <p className={className}>
        <span className="font-medium">{formatShiftDate(shift.date)}</span> · {l.typeName && `${l.typeName} · `}
        {shift.roleName} · <span data-testid={testId}>{l.times}</span>
        {l.nextDay && (
          <span className="rota-next-day ml-1" title="Ends next day">
            +1
          </span>
        )}
      </p>
      {l.note && <p className="mt-0.5 text-xs text-muted-foreground">{l.note}</p>}
    </>
  );
}
