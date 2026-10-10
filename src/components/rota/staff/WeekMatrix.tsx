import type { WeekDocDto } from '../../../../shared/rotaWeek';

/**
 * Placeholder — replaced by the read-only Team Matrix build: person × day
 * codes (M / D / E / S, Off, Leave, Sick) derived from the same week document
 * the grid uses, so the two can never disagree (Design board E).
 */
export interface WeekMatrixProps {
  week: WeekDocDto;
}

export function WeekMatrix(_props: WeekMatrixProps) {
  return null;
}
