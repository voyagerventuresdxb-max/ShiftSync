import type { SystemRole } from '@prisma/client';
import { Type } from '@google/genai';

// The role → intent table is shared with the client (shared/voiceIntents.ts),
// which refuses to open the confirm sheet for an out-of-role intent before
// anything reaches /execute; the 403 below stays the real guard.
import { STAFF_INTENTS, MANAGER_INTENTS } from '../../../shared/voiceIntents.js';
export { STAFF_INTENTS, MANAGER_INTENTS };

export type StaffIntentType = (typeof STAFF_INTENTS)[number];
export type ManagerIntentType = (typeof MANAGER_INTENTS)[number];
export type IntentType = ManagerIntentType;

/**
 * Names for the confirm sheet's preview, filled in by the server from the caller's own venue
 * (parseIntent.ts `describeReading`), never by the model. /execute ignores it.
 */
export interface ReadingDetails {
  /** The person this is about: shout-out recipient, cover, assignee, applicant, or swap requester. */
  person?: string | null;
  /** APPROVE_SWAP/DECLINE_SWAP: who was asked to cover. */
  cover?: string | null;
  /** CREATE_SHIFT/EDIT_SHIFT: the role name (EDIT_SHIFT: only when it changes). */
  role?: string;
  /** ASSIGN_SECTION: the section's label. */
  section?: string;
  /** The existing shift a reading refers to (REQUEST_SWAP, APPROVE/DECLINE_SWAP, EDIT_SHIFT). */
  shift?: { date: string; start: string; end: string; role?: string; person?: string | null };
}

/**
 * `targetUserName` on the person-naming intents is the name as the caller said it when it comes
 * from the model, and the person's full name from the venue's staff list once the server has
 * matched it (parseIntent.ts `checkAgainstContext`).
 */
type Action =
  | { intent: 'MARK_AVAILABILITY'; date: string; type: 'UNAVAILABLE' | 'PREFERRED_OFF'; confidence: number; summary: string }
  | { intent: 'REQUEST_SWAP'; shiftId: string; targetUserId: string; targetUserName: string; reason: string | null; confidence: number; summary: string }
  | { intent: 'APPROVE_SWAP'; swapRequestId: string; confidence: number; summary: string }
  | { intent: 'DECLINE_SWAP'; swapRequestId: string; confidence: number; summary: string }
  | { intent: 'APPROVE_JOIN'; joinRequestId: string; confidence: number; summary: string }
  | { intent: 'DECLINE_JOIN'; joinRequestId: string; confidence: number; summary: string }
  | { intent: 'CREATE_SHIFT'; roleId: string; date: string; start: string; end: string; userId: string | null; targetUserName?: string; confidence: number; summary: string }
  | { intent: 'EDIT_SHIFT'; shiftId: string; roleId?: string; date?: string; start?: string; end?: string; userId?: string | null; targetUserName?: string; confidence: number; summary: string }
  | { intent: 'ASSIGN_SECTION'; sectionId: string; staffId: string; shiftDate: string; period: 'AM' | 'PM'; dutyLabel: string | null; targetUserName?: string; confidence: number; summary: string }
  | { intent: 'PUBLISH_ROTA'; weekStart: string; confidence: number; summary: string }
  | { intent: 'APPLY_ROTA_TEMPLATE'; templateId: string | null; templateName: string; weekStart: string; confidence: number; summary: string }
  | { intent: 'POST_ANNOUNCEMENT'; content: string; confidence: number; summary: string }
  | { intent: 'POST_SHOUTOUT'; targetUserId: string; targetUserName: string; content: string; confidence: number; summary: string }
  | { intent: 'QUERY_MY_SCHEDULE'; confidence: number; summary: string };

/**
 * `person`: the caller named someone the server could not pin down in their own venue — nobody by
 * that name (`missing`), or more than one (`ambiguous`). `options` then holds one complete reading
 * per candidate, if any.
 */
export type PersonQuestion = { heard: string; status: 'missing' | 'ambiguous' };

export type ParsedIntent =
  | (Action & { details?: ReadingDetails })
  | { intent: 'UNRECOGNIZED'; reason: string; summary: string; options?: ChoosableIntent[]; person?: PersonQuestion };

/** An intent the caller can pick from a "which did you mean?" list: an action, never a question or a non-answer. */
export type ChoosableIntent = Exclude<ParsedIntent, { intent: 'UNRECOGNIZED' | 'QUERY_MY_SCHEDULE' }>;

function readingSchema(intents: readonly string[]) {
  return {
    type: Type.OBJECT,
    properties: {
      intent: { type: Type.STRING, enum: [...intents, 'UNRECOGNIZED'] },
      date: { type: Type.STRING, nullable: true, description: 'YYYY-MM-DD, for MARK_AVAILABILITY/CREATE_SHIFT/EDIT_SHIFT' },
      availabilityType: { type: Type.STRING, enum: ['UNAVAILABLE', 'PREFERRED_OFF'], nullable: true },
      shiftId: { type: Type.STRING, nullable: true, description: 'For REQUEST_SWAP/EDIT_SHIFT — one of the ids in the provided shift list' },
      targetUserId: {
        type: Type.STRING,
        nullable: true,
        description:
          'For REQUEST_SWAP (the colleague asked to cover) and POST_SHOUTOUT (the person being thanked) — the id from the provided staff list of the ONE person whose name matches. Leave null when nobody in the list matches the name, or when two or more people share it; never choose between people who share a name.',
      },
      targetUserName: {
        type: Type.STRING,
        nullable: true,
        description:
          'The person\'s name exactly as the caller said it (e.g. "Omar", "Layla Nasser") whenever the request names a person: the POST_SHOUTOUT recipient, the REQUEST_SWAP colleague, the person a CREATE_SHIFT is for, the new person for an EDIT_SHIFT, or the person in an ASSIGN_SECTION. Always fill it in, even when the name is not in the staff list or matches more than one person — the app looks the name up and asks the caller if needed. Leave it empty when no person is named (an open shift, or only changing a shift\'s time).',
      },
      reason: { type: Type.STRING, nullable: true },
      swapRequestId: { type: Type.STRING, nullable: true, description: 'For APPROVE_SWAP/DECLINE_SWAP — one of the ids in the provided pending-swaps list' },
      joinRequestId: { type: Type.STRING, nullable: true, description: 'For APPROVE_JOIN/DECLINE_JOIN — one of the ids in the provided pending-joins list' },
      roleId: { type: Type.STRING, nullable: true, description: 'For CREATE_SHIFT/EDIT_SHIFT — one of the ids in the provided roles list' },
      userId: {
        type: Type.STRING,
        nullable: true,
        description:
          'For CREATE_SHIFT/EDIT_SHIFT — the id from the provided staff list of the one person whose name matches. Null for an open/unassigned shift (then leave targetUserName empty), or when the named person is not in the list or shares their name with someone else (then still fill targetUserName). For EDIT_SHIFT, leave it out entirely when the person on the shift does not change.',
      },
      start: { type: Type.STRING, nullable: true, description: 'HH:MM, for CREATE_SHIFT/EDIT_SHIFT' },
      end: { type: Type.STRING, nullable: true, description: 'HH:MM, for CREATE_SHIFT/EDIT_SHIFT' },
      sectionId: { type: Type.STRING, nullable: true, description: 'For ASSIGN_SECTION — one of the ids in the provided floor sections list' },
      staffId: {
        type: Type.STRING,
        nullable: true,
        description: 'For ASSIGN_SECTION — the id from the provided staff list of the one person whose name matches; null when nobody matches or two or more people share the name (still fill targetUserName).',
      },
      shiftDate: { type: Type.STRING, nullable: true, description: 'YYYY-MM-DD, for ASSIGN_SECTION' },
      period: { type: Type.STRING, enum: ['AM', 'PM'], nullable: true, description: 'For ASSIGN_SECTION' },
      dutyLabel: { type: Type.STRING, nullable: true, description: 'For ASSIGN_SECTION — optional free-text duty note' },
      weekStart: { type: Type.STRING, nullable: true, description: 'YYYY-MM-DD, the Monday of the target week, for PUBLISH_ROTA/APPLY_ROTA_TEMPLATE — resolve relative phrases like "this week"/"next week" against today.' },
      templateId: { type: Type.STRING, nullable: true, description: 'For APPLY_ROTA_TEMPLATE — one of the ids in the provided rota-templates list, if you can confidently match the spoken template name to one. Leave null rather than guessing the nearest name if you are not confident.' },
      templateName: { type: Type.STRING, nullable: true, description: 'For APPLY_ROTA_TEMPLATE — the template name as referenced in the transcript, even if you are not fully certain which saved template it maps to.' },
      content: {
        type: Type.STRING,
        nullable: true,
        description:
          'For POST_ANNOUNCEMENT — the exact announcement text to post, exactly as it will be shown to staff. For POST_SHOUTOUT — the exact recognition note text. In both cases: lightly clean filler words ("um", "uh"), false starts, and obvious punctuation/capitalization from the transcript, but never paraphrase, shorten, summarize, or add content beyond what was actually said. This is the literal text that will be posted, verbatim, with no further editing.',
      },
      confidence: { type: Type.NUMBER, nullable: true, description: 'How certain you are (0 to 1) that every id/date/time above is correct and unambiguous. Required for every intent except UNRECOGNIZED.' },
      hasAdditionalRequest: {
        type: Type.BOOLEAN,
        nullable: true,
        description:
          'True if the transcript contains more than one distinct actionable request beyond the one captured in `intent` — set this independently of how confident you are about `intent`/`confidence`. Examples of two requests in one utterance: "move Ahmed to bar and create a shift for Layla Saturday", "what is my schedule and also move Ahmed to the bar Friday PM". A single request with extra detail (a reason, a time range) is NOT two requests.',
      },
      summary: {
        type: Type.STRING,
        description:
          "One plain-English sentence describing exactly what will happen, for the confirm step — except for QUERY_MY_SCHEDULE, where this is the direct answer to the caller's question instead, and for UNRECOGNIZED, where it is a short, friendly sentence to the caller (e.g. \"I didn't catch which day you meant.\").",
      },
      unrecognizedReason: {
        type: Type.STRING,
        nullable: true,
        description:
          'Required when intent=UNRECOGNIZED: one short, friendly sentence to the caller saying what was missing or unclear and what to say instead (e.g. "Say which day, for example \\"next Friday\\"."). Never mention intents, ids, lists, schemas or commands.',
      },
    },
    required: ['intent', 'summary'],
  };
}

/**
 * The model's answer, plus up to two other complete readings when it isn't sure which one the
 * caller meant. parseIntent.ts checks each reading like the main answer and offers the ones that
 * pass as choices; nothing runs until the caller picks one and confirms it.
 */
function schemaFor(intents: readonly string[]) {
  const main = readingSchema(intents);
  const reading = Object.fromEntries(Object.entries(main.properties).filter(([key]) => key !== 'hasAdditionalRequest' && key !== 'unrecognizedReason'));
  return {
    ...main,
    properties: {
      ...main.properties,
      alternatives: {
        type: Type.ARRAY,
        nullable: true,
        description:
          'Only when your confidence is below 0.6 because the words fit two or three different actions (for example approving or declining the same swap request): up to 2 OTHER complete readings, each filled in exactly like the main answer, with its own intent, ids, confidence and summary. The app shows them as choices, and nothing happens until the caller picks one and confirms. Leave empty when you are confident, or when the request is simply unclear.',
        items: { type: Type.OBJECT, properties: { ...reading, intent: { type: Type.STRING, enum: [...intents] } }, required: ['intent', 'summary'] },
      },
    },
  };
}

const STAFF_SCHEMA = schemaFor(STAFF_INTENTS);
const MANAGER_SCHEMA = schemaFor(MANAGER_INTENTS);

export function intentSchemaFor(systemRole: SystemRole) {
  return systemRole === 'STAFF' ? STAFF_SCHEMA : MANAGER_SCHEMA;
}

export function allowedIntentsFor(systemRole: SystemRole): readonly string[] {
  return systemRole === 'STAFF' ? STAFF_INTENTS : MANAGER_INTENTS;
}
