import { escalationConfig, type EscalationConfig } from '../lib/aiConfig.js';
import type { ParsedVisionResult } from './types.js';

/**
 * When a roster goes past the deterministic parsers to the vision provider. The deterministic
 * parsers always run first; these are the only reasons the AI reader is used:
 *  - image_or_scan       a photo, screenshot or image-only PDF (nothing to parse locally)
 *  - extraction_anomaly  the grid parser recognised the layout but proved it dropped real shift
 *                        data (RosterExtractionAnomalyError) — no trustworthy local result
 *  - unrecognized_layout a spreadsheet / text PDF none of the deterministic parsers could read
 *  - all_caps_venue      every staff name is written in capitals, which defeats the parser's
 *                        "headers are in caps" signal; the local result exists but is suspect
 *  - empty_roles         more than the configured share of shift rows have no role
 */
export type EscalationReason = 'image_or_scan' | 'extraction_anomaly' | 'unrecognized_layout' | 'all_caps_venue' | 'empty_roles';

/** Manager-facing reason, used in the consent prompt and the review-screen notice. */
export const ESCALATION_REASON_TEXT: Record<EscalationReason, string> = {
  image_or_scan: 'This is a photo or scanned file, so it can only be read by the AI reader.',
  extraction_anomaly: "Part of this roster couldn't be matched to staff reliably, so it needs the AI reader.",
  unrecognized_layout: "This roster's layout isn't one the built-in reader knows, so it needs the AI reader.",
  all_caps_venue: 'Every name on this roster is in capital letters, which the built-in reader can confuse with section headings. The AI reader can double-check it.',
  empty_roles: 'Many shifts on this roster came out without a role. The AI reader can usually fill those in.',
};

/** A label written entirely in capitals (at least 3 letters, so initials and "AM" don't count). */
export function isAllCapsLabel(label: string): boolean {
  const letters = label.replace(/[^\p{L}]/gu, '');
  return letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

/**
 * Should a SUCCESSFUL deterministic grid result still be escalated? Returns the reason, or null.
 * Only for grid-parser results (day-column rosters): long-format templates carry an explicit
 * role column, so a blank role there is the manager's own data, not a parse failure.
 */
export function deterministicEscalationReason(
  result: { rows: Pick<ParsedVisionResult['rows'][number], 'employeeName' | 'roleName'>[] },
  config: EscalationConfig = escalationConfig(),
): 'all_caps_venue' | 'empty_roles' | null {
  if (result.rows.length === 0) return null;
  const names = [...new Set(result.rows.map((r) => r.employeeName.trim()).filter(Boolean))];
  if (names.length >= 2 && names.every(isAllCapsLabel)) return 'all_caps_venue';
  const emptyRoleRows = result.rows.filter((r) => !r.roleName?.trim()).length;
  if (emptyRoleRows / result.rows.length > config.emptyRoleShare) return 'empty_roles';
  return null;
}
