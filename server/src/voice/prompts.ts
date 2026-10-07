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
  pendingSwapRequests?: { id: string; requesterName: string; coverName?: string | null; shiftLabel: string; shift?: { date: string; start: string; end: string } }[];
  pendingJoinRequests?: { id: string; fullName: string; phone: string }[];
  /** Manager-tier only — every role at this venue, for CREATE_SHIFT/EDIT_SHIFT. */
  roles?: { id: string; name: string }[];
  /** Manager-tier only — every shift at this venue from today through +7 days, for EDIT_SHIFT/ASSIGN_SECTION reference. */
  weekShifts?: { id: string; roleName: string; date: string; start: string; end: string; assigneeName: string | null }[];
  /** Manager-tier only — every floor section at this venue, for ASSIGN_SECTION. */
  floorSections?: { id: string; label: string }[];
  /** Manager-tier only — every saved rota template at this venue, for APPLY_ROTA_TEMPLATE. */
  rotaTemplates?: { id: string; name: string }[];
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Monday 2031-03-03" for `today` plus `offset` days. */
export function calendarDay(today: string, offset: number): string {
  const d = new Date(`${today}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.toISOString().slice(0, 10)}`;
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
    `You are ShiftSync's voice command interpreter for a hospitality venue in the UAE. Today is ${calendarDay(ctx.today, 0)}. The caller is ${ctx.callerName}, whose account role is ${systemRole}.`,
    ``,
    // Weekday arithmetic is where dates went wrong; the model reads the day instead of computing it.
    `Calendar (use it for every weekday, "tomorrow", "next week" and similar — never compute dates yourself): ${Array.from({ length: 14 }, (_, i) => calendarDay(ctx.today, i)).join('; ')}. Weeks start on Monday.`,
    ``,
    `You may ONLY ever respond with one of these intents: ${allowed.join(', ')}, or UNRECOGNIZED if none of them confidently match what was said. Never invent an intent outside this list — the caller's role does not permit anything else, and any other intent will be rejected by the server regardless of what you output.`,
    ``,
    `Known staff at this venue (name → id, use these ids, never invent one):`,
    ...ctx.staffDirectory.map((s) => `- ${s.fullName} → ${s.id}`),
    ``,
    // The app looks the spoken name up itself (parseIntent.ts), so a missing or shared name is a
    // question for the caller, not a reason to give up or to guess.
    `People: whenever the caller names a person, put the name exactly as you heard it in "targetUserName" ("me" or "myself" means the caller, ${ctx.callerName}). Fill in that person's id only when exactly one person in the staff list above has that name. When nobody in the list has it, or two or more people share it (for example two people called Omar), still answer with the intent the caller asked for, leave the id null, and keep "targetUserName" — the app will ask the caller who they meant. Never choose between people who share a name, and never answer UNRECOGNIZED only because of a person's name.`,
  ];

  // Both REQUEST_SWAP and QUERY_MY_SCHEDULE depend on this block for their
  // only source of the caller's own shift data — keep this condition in
  // sync with STAFF_INTENTS if either intent's gating ever changes.
  if (allowed.includes('REQUEST_SWAP') || allowed.includes('QUERY_MY_SCHEDULE')) {
    lines.push(``, `The caller's own upcoming shifts (id → date, time):`);
    lines.push(...ctx.callerShifts.map((s) => `- ${s.id} → ${s.date}, ${s.startTime}-${s.endTime}`));
  }

  if (ctx.pendingSwapRequests?.length) {
    lines.push(``, `Pending swap requests this caller could approve or decline (id → who requested, who was asked to cover, which shift):`);
    lines.push(...ctx.pendingSwapRequests.map((r) => `- ${r.id} → ${r.requesterName}${r.coverName ? `, asking ${r.coverName} to cover` : ''}, ${r.shiftLabel}`));
  }

  // Names only: an applicant's phone number is not needed to match "approve Riya" and is not sent.
  if (ctx.pendingJoinRequests?.length) {
    lines.push(``, `Pending join requests this caller could approve or decline (id → name):`);
    lines.push(...ctx.pendingJoinRequests.map((r) => `- ${r.id} → ${r.fullName}`));
  }

  if (ctx.pendingSwapRequests?.length || ctx.pendingJoinRequests?.length) {
    lines.push(
      ``,
      `For APPROVE_SWAP/DECLINE_SWAP/APPROVE_JOIN/DECLINE_JOIN: when exactly one pending request above matches who or what the caller named (or there is only one pending request of that kind and the caller says "the pending one"), that match is unambiguous — use its id with high confidence. If two or more could match, respond with UNRECOGNIZED and say which ones.`,
    );
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
    lines.push(`For ASSIGN_SECTION, "period" is AM for morning or lunch, and PM for afternoon, evening or night ("tomorrow evening" is PM). "On the bar" means the Bar section when one is listed.`);
  }

  if (ctx.rotaTemplates?.length) {
    lines.push(``, `Saved rota templates at this venue (name → id, for APPLY_ROTA_TEMPLATE):`);
    lines.push(...ctx.rotaTemplates.map((t) => `- ${t.name} → ${t.id}`));
    lines.push(
      `For APPLY_ROTA_TEMPLATE: always fill in "templateName" with the template as referenced in the transcript, even if unsure. Only fill in "templateId" if you are genuinely confident which saved template above it matches — leave it null rather than picking the nearest-sounding name if there is real ambiguity (e.g. two similarly-named templates). The server independently re-checks this match, so guessing here does not help — it only risks a wrong or ambiguous apply.`,
    );
  }

  if (allowed.includes('PUBLISH_ROTA')) {
    lines.push(
      ``,
      `For PUBLISH_ROTA: resolve "weekStart" (the Monday of the target week) from phrases like "this week"/"next week"/a specific date, relative to today. Do not attempt to state how many shifts or staff will be affected in "summary" — the server computes and fills in the exact affected count itself before this is shown to the caller.`,
    );
  }

  if (allowed.includes('POST_ANNOUNCEMENT') || allowed.includes('POST_SHOUTOUT')) {
    lines.push(
      ``,
      `For POST_ANNOUNCEMENT and POST_SHOUTOUT: put the exact text to post in "content" — clean up filler words and false starts, but never paraphrase, shorten, or add anything beyond what the caller actually said. "content" is what gets posted verbatim; do not describe it in "summary" instead — keep "summary" to a short framing sentence only (e.g. "Post this announcement to the venue", "Give {name} a shoutout with this note"), since the caller will see the full "content" text separately before confirming.`,
    );
  }

  if (allowed.includes('POST_SHOUTOUT')) {
    lines.push(
      `For POST_SHOUTOUT: the recipient is the person being thanked or praised ("give Sam a shout-out saying great job" → recipient Sam, content "Great job"). Put their name as you heard it in "targetUserName" and, only when exactly one listed person has that name, their id in "targetUserId".`,
    );
  }

  if (allowed.includes('QUERY_MY_SCHEDULE')) {
    lines.push(
      ``,
      `For QUERY_MY_SCHEDULE specifically: answer using ONLY the caller's own upcoming shifts already listed above — you have no visibility into anyone else's schedule, so never claim to. Put the direct, final answer to their question directly in "summary" (e.g. "You're working Friday 6pm-close and Saturday 2pm-10pm this weekend", or "You have no shifts scheduled this week") — do NOT describe a pending action, since nothing will be written. If the question's date range is genuinely ambiguous (e.g. "next week" without clear bounds you can resolve against today's date), respond with UNRECOGNIZED instead of guessing. If a venue-wide shift list also appears below (it will for manager/owner callers), it is NOT a valid source for this intent — never use it to answer QUERY_MY_SCHEDULE, even though you may use it for other intents. If the question is actually asking about a different named person's schedule, that is out of scope for QUERY_MY_SCHEDULE and no tool available to this role can answer it — respond UNRECOGNIZED rather than answering from the venue-wide list.`,
    );
  }

  lines.push(
    ``,
    `If a date, time, role, shift, section, request or template is ambiguous or you cannot find a confident match in the lists above, respond with intent=UNRECOGNIZED and always say why in unrecognizedReason, as one short, friendly sentence to the caller (e.g. "I didn't catch which day you meant.") — never mention intents, ids or lists. A person's name is the exception, handled as described under People above. Never guess an id that isn't listed above, and never invent a date or time.`,
    `Every key in the response is required: fill in each one the intent uses (for CREATE_SHIFT that is the role, date, start AND end; for ASSIGN_SECTION the section, date AND period), and null for every key it doesn't use. If the caller left one out, still answer with their intent and leave that key null — the app asks them for it.`,
    `Always fill in "summary" with one plain-English sentence describing exactly what will happen if this is confirmed (except for QUERY_MY_SCHEDULE, where summary is the direct answer itself, as described above) — e.g. "Mark you unavailable on Friday, August 29th", "Approve Sarah's swap request for her Tuesday shift", "Create a Bartender shift for Ahmed, Friday 6pm-2am", or "Move Ahmed to the Bar section, Friday PM."`,
    `Always fill in "confidence" (0 to 1) with how certain you are that this exactly matches what the caller asked for and that every id/date/time you filled in is correct — lower it whenever a name, date, or time was even slightly ambiguous before you resolved it. A clear request whose people, dates and times all match the lists and the calendar above exactly deserves at least 0.8; keep low confidence for when you actually had to choose between possibilities.`,
    `When your confidence is low only because the words fit two or three different actions with ids from the lists above (for example approving or declining the same swap request), give your best reading as the main answer and the other one or two in "alternatives", each complete with its own ids, confidence and summary. The caller picks one and confirms it. Leave "alternatives" empty otherwise, and never put an id there that isn't listed above.`,
    `Always fill in "hasAdditionalRequest" (true/false): set it to true if the transcript contains more than one distinct actionable request — even if you can only confidently resolve one of them into "intent". Judge this independently of "confidence": being unsure whether there's a second request must never lower your confidence in the one you did resolve, and being very confident in "intent" must never stop you from flagging a second request if one is genuinely there. Do not try to describe or resolve the second request anywhere in your response — the caller will be asked to state it again separately.`,
  );

  return lines.join('\n');
}
