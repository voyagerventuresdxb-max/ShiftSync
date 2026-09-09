import type { SystemRole } from '@prisma/client';
import { allowedIntentsFor } from './intentSchema.js';

export interface PromptContext {
  today: string; // YYYY-MM-DD
  callerName: string;
  /** The caller's own upcoming shifts — only relevant/populated for REQUEST_SWAP. */
  callerShifts: { id: string; date: string; startTime: string; endTime: string }[];
  /** Every active staff member at this location, for name resolution. */
  staffDirectory: { id: string; fullName: string }[];
  /** Only populated for manager-tier callers — the pending decisions they could be asked to act on. */
  pendingSwapRequests?: { id: string; requesterName: string; shiftLabel: string }[];
  pendingJoinRequests?: { id: string; fullName: string; phone: string }[];
  /** Manager-tier only — every role at this venue, for CREATE_SHIFT/EDIT_SHIFT. */
  roles?: { id: string; name: string }[];
  /** Manager-tier only — every shift at this venue from today through +7 days, for EDIT_SHIFT/ASSIGN_SECTION reference. */
  weekShifts?: { id: string; roleName: string; date: string; start: string; end: string; assigneeName: string | null }[];
  /** Manager-tier only — every floor section at this venue, for ASSIGN_SECTION. */
  floorSections?: { id: string; label: string }[];
}

/**
 * Builds the role-scoped system prompt. The allowed-intents list is generated
 * from the SAME array `intentSchemaFor` restricts the response schema to —
 * this function never hand-types a separate list, so the prompt text and the
 * schema enum can never drift apart.
 */
export function buildSystemPrompt(systemRole: SystemRole, ctx: PromptContext): string {
  const allowed = allowedIntentsFor(systemRole);
  const lines = [
    `You are ShiftSync's voice command interpreter for a hospitality venue in the UAE. Today is ${ctx.today}. The caller is ${ctx.callerName}, whose account role is ${systemRole}.`,
    ``,
    `You may ONLY ever respond with one of these intents: ${allowed.join(', ')}, or UNRECOGNIZED if none of them confidently match what was said. Never invent an intent outside this list — the caller's role does not permit anything else, and any other intent will be rejected by the server regardless of what you output.`,
    ``,
    `Known staff at this venue (name → id, use these ids, never invent one):`,
    ...ctx.staffDirectory.map((s) => `- ${s.fullName} → ${s.id}`),
  ];

  if (allowed.includes('REQUEST_SWAP')) {
    lines.push(``, `The caller's own upcoming shifts (id → date, time):`);
    lines.push(...ctx.callerShifts.map((s) => `- ${s.id} → ${s.date}, ${s.startTime}-${s.endTime}`));
  }

  if (ctx.pendingSwapRequests?.length) {
    lines.push(``, `Pending swap requests this caller could approve or decline (id → who requested, which shift):`);
    lines.push(...ctx.pendingSwapRequests.map((r) => `- ${r.id} → ${r.requesterName}, ${r.shiftLabel}`));
  }

  if (ctx.pendingJoinRequests?.length) {
    lines.push(``, `Pending join requests this caller could approve or decline (id → name, phone):`);
    lines.push(...ctx.pendingJoinRequests.map((r) => `- ${r.id} → ${r.fullName}, ${r.phone}`));
  }

  if (ctx.roles?.length) {
    lines.push(``, `Roles at this venue (name → id, for CREATE_SHIFT/EDIT_SHIFT — use these ids, never invent one):`);
    lines.push(...ctx.roles.map((r) => `- ${r.name} → ${r.id}`));
  }

  if (ctx.weekShifts?.length) {
    lines.push(``, `This venue's shifts, today through the next 7 days (id → role, date, time, who's assigned or "open" — for EDIT_SHIFT/ASSIGN_SECTION reference):`);
    lines.push(...ctx.weekShifts.map((s) => `- ${s.id} → ${s.roleName}, ${s.date} ${s.start}-${s.end}, ${s.assigneeName ?? 'open'}`));
  }

  if (ctx.floorSections?.length) {
    lines.push(``, `Floor sections at this venue (name → id, for ASSIGN_SECTION — use these ids, never invent one):`);
    lines.push(...ctx.floorSections.map((s) => `- ${s.label} → ${s.id}`));
  }

  if (allowed.includes('QUERY_MY_SCHEDULE')) {
    lines.push(
      ``,
      `For QUERY_MY_SCHEDULE specifically: answer using ONLY the caller's own upcoming shifts already listed above — you have no visibility into anyone else's schedule, so never claim to. Put the direct, final answer to their question directly in "summary" (e.g. "You're working Friday 6pm-close and Saturday 2pm-10pm this weekend", or "You have no shifts scheduled this week") — do NOT describe a pending action, since nothing will be written. If the question's date range is genuinely ambiguous (e.g. "next week" without clear bounds you can resolve against today's date), respond with UNRECOGNIZED instead of guessing.`,
    );
  }

  lines.push(
    ``,
    `If a name, date, time, role, shift, or section is ambiguous or you cannot find a confident match in the lists above, respond with intent=UNRECOGNIZED and explain why in unrecognizedReason — never guess an id that isn't listed above, and never invent a date or time.`,
    `Always fill in "summary" with one plain-English sentence describing exactly what will happen if this is confirmed, e.g. "Mark you unavailable on Friday, August 29th", "Approve Sarah's swap request for her Tuesday shift", "Create a Bartender shift for Ahmed, Friday 6pm-2am", or "Move Ahmed to the Bar section, Friday PM."`,
    `Always fill in "confidence" (0 to 1) with how certain you are that this exactly matches what the caller asked for and that every id/date/time you filled in is correct — lower it whenever a name, date, or time was even slightly ambiguous before you resolved it.`,
  );

  return lines.join('\n');
}
