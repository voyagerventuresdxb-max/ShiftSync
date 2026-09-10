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

  lines.push(
    ``,
    `If a name or date is ambiguous or you cannot find a confident match in the lists above, respond with intent=UNRECOGNIZED and explain why in unrecognizedReason — never guess an id that isn't listed above.`,
    `Always fill in "summary" with one plain-English sentence describing exactly what will happen if this is confirmed, e.g. "Mark you unavailable on Friday, August 29th" or "Approve Sarah's swap request for her Tuesday shift."`,
  );

  return lines.join('\n');
}
