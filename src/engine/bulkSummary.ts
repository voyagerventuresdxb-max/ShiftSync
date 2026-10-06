/**
 * The one-line result of a bulk action in the rota builder. Every shift is
 * written on its own (so each keeps its own audit row and notification), so
 * some can be refused — overlap, leave — while the rest go through; the
 * message says how many of each and the first reason.
 */
export function bulkSummary(verb: 'Assigned' | 'Deleted', done: number, refusals: string[]): string {
  const shifts = (n: number) => `${n} shift${n === 1 ? '' : 's'}`;
  if (refusals.length === 0) return `${verb} ${shifts(done)}.`;
  return `${verb} ${shifts(done)}; ${refusals.length} refused — ${refusals[0]}`;
}
