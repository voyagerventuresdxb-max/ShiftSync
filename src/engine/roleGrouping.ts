/**
 * Shared role-based grouping for the roster grid, Team Matrix, and Rota
 * Builder — one classification module, not one per screen. Framework
 * agnostic (no React/DOM imports), matching engine/types.ts's contract.
 */

export interface RoleSection {
  key: string;
  label: string;
  match: string[];
}

/**
 * Ordered role sections for the categorized roster grid, matching the
 * 7shifts-style mobile reference layout. Staff are grouped under these
 * headers in this order; any role not listed falls into "Other".
 */
export const ROLE_SECTIONS: RoleSection[] = [
  { key: 'manager', label: 'Management', match: ['management', 'manager', 'gm', 'floor manager', 'general manager', 'restaurant manager', 'duty manager', 'operations manager', 'assistant manager'] },
  { key: 'supervisor', label: 'Supervisor', match: ['supervisor', 'supervisors', 'team leader', 'team lead', 'shift supervisor', 'floor supervisor'] },
  { key: 'head-waiter', label: 'Head Waiter', match: ['head waiter', 'head waiters', 'head server', 'senior waiter'] },
  { key: 'waiter', label: 'Waiter', match: ['waiter', 'waiters', 'server', 'servers', 'wait staff', 'waiting staff', 'floor', 'floor staff', 'floor team', 'floor service'] },
  { key: 'runner', label: 'Runner', match: ['runner', 'runners', 'food runner', 'bar runner'] },
];

/** Normalize a role string for section matching (lowercase, alnum+space). */
export function roleKey(role: string): string {
  return role.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Normalize a person's name for job-title lookup (lowercase, trimmed). */
export function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** True when a job title indicates Management — pattern-based, not a fixed word list, so any venue's own manager-ish title works. */
export function isManagementTitle(jobTitle: string): boolean {
  return /manager|management/i.test(jobTitle);
}

/** Resolve a role string to a section key, defaulting to 'other'. */
export function sectionForRole(role: string): string {
  const key = roleKey(role);
  for (const section of ROLE_SECTIONS) {
    if (section.match.some((m) => roleKey(m) === key)) return section.key;
  }
  return 'other';
}

/**
 * Resolve a person to a grid section, cross-referencing a job-title map
 * FIRST — a venue-confirmed job title always wins over whatever their
 * parsed `role` says. `jobTitleByName` is keyed by `nameKey(name)`.
 */
export function sectionForEmployee(
  person: { name: string; role: string },
  jobTitleByName: Map<string, string | null | undefined>,
): string {
  const jobTitle = jobTitleByName.get(nameKey(person.name));
  if (jobTitle && isManagementTitle(jobTitle)) return 'manager';
  return sectionForRole(person.role);
}

export interface GroupedSection<E> {
  key: string;
  label: string;
  employees: E[];
  flagged?: boolean;
}

/**
 * Group a list of people into ordered role sections. Anyone flagged
 * `needsRoleReview` never enters normal role grouping — they get their own
 * dedicated, visually-flagged section shown first, since an unresolved role
 * needs the manager's attention more than any coincidental section match.
 */
export function groupIntoSections<E extends { id: string; name: string; role: string; needsRoleReview?: boolean }>(
  people: E[],
  jobTitleByName: Map<string, string | null | undefined>,
): GroupedSection<E>[] {
  const needsReview = people.filter((p) => p.needsRoleReview);
  const grouped = new Map<string, E[]>();
  for (const person of people) {
    if (person.needsRoleReview) continue;
    const key = sectionForEmployee(person, jobTitleByName);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(person);
  }

  const ordered: GroupedSection<E>[] = [];
  if (needsReview.length > 0) {
    ordered.push({ key: 'needs-review', label: 'Needs Review — Role Unresolved', employees: needsReview, flagged: true });
  }
  for (const section of ROLE_SECTIONS) {
    const people = grouped.get(section.key);
    if (people && people.length > 0) {
      ordered.push({ key: section.key, label: section.label, employees: people });
    }
  }
  const other = grouped.get('other');
  if (other && other.length > 0) {
    ordered.push({ key: 'other', label: 'Other', employees: other });
  }
  return ordered;
}
