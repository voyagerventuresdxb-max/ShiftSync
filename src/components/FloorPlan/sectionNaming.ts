/**
 * The name a new section is saved under when the manager leaves the name
 * blank: the first free "Section N", counting on from the sections that
 * already exist. New sections start with an empty name and real examples
 * (Terrace, Bar, Main floor) instead of a prefilled number; this is only the
 * fallback, so Add never fails for want of a name. See docs/floor-sections.md.
 */
export function fallbackSectionLabel(existingLabels: readonly string[]): string {
  const taken = new Set(existingLabels.map((l) => l.trim().toLowerCase()));
  let n = existingLabels.length + 1;
  while (taken.has(`section ${n}`)) n++;
  return `Section ${n}`;
}
