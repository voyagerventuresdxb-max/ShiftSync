import type { SystemRole } from '@prisma/client';
import { Type } from '@google/genai';

// The role → intent table is shared with the client (shared/voiceIntents.ts),
// which refuses to open the confirm sheet for an out-of-role intent before
// anything reaches /execute; the 403 below stays the real guard.
import { STAFF_INTENTS, MANAGER_INTENTS, READ_VOICE_INTENTS } from '../../../shared/voiceIntents.js';
export { STAFF_INTENTS, MANAGER_INTENTS, READ_VOICE_INTENTS };

export type StaffIntentType = (typeof STAFF_INTENTS)[number];
export type ManagerIntentType = (typeof MANAGER_INTENTS)[number];
export type IntentType = ManagerIntentType;
export type ReadIntentType = (typeof READ_VOICE_INTENTS)[number];

/**
 * Names for the confirm sheet's preview, filled in by the server from the caller's own venue
 * (parseIntent.ts `describeReading`), never by the model. /execute ignores it.
 */
export interface ReadingDetails {
  /** The person this is about: shout-out recipient, cover, assignee, applicant, or swap requester. */
  person?: string | null;
  /** That person's own role at the venue ("Bartender"), so a wrong match is visible at a glance. */
  personRole?: string | null;
  /** APPROVE_SWAP/DECLINE_SWAP: who was asked to cover. */
  cover?: string | null;
  /** CREATE_SHIFT/EDIT_SHIFT: the role name (EDIT_SHIFT: only when it changes). CANCEL_SHIFT: the shift's role. */
  role?: string | null;
  /** ASSIGN_SECTION: the section's label. */
  section?: string;
  /** The existing shift a reading refers to (REQUEST_SWAP, APPROVE/DECLINE_SWAP, EDIT_SHIFT). */
  shift?: { date: string; start: string; end: string; role?: string; person?: string | null };
  /** CANCEL_SHIFT: the shift being removed. */
  date?: string;
  start?: string;
  end?: string;
}

/** A read's answer, written by the server from the venue's records; the UI renders it as text only. */
export interface ReadAnswer {
  title: string;
  items: Array<{ primary: string; secondary?: string; tertiary?: string }>;
  /** Shown when `items` is empty. */
  emptyText: string;
}

/** What may never be done by voice; the server writes the message and the screen link. */
export const DECLINED_CATEGORIES = [
  'people_deactivate_delete',
  'roles_permissions',
  'signin_phone',
  'account_delete',
  'kiosk_link',
  'ai_settings',
  'payroll_wps',
  'floor_plan_pins',
  'other_settings',
] as const;
export type DeclinedCategory = (typeof DECLINED_CATEGORIES)[number];

/**
 * `targetUserName` on the person-naming intents is the name as the caller said it before the
 * server matched it, and the person's full name from the venue's staff list once it has
 * (parseIntent.ts `checkAgainstContext`).
 */
type Action =
  | { intent: 'MARK_AVAILABILITY'; date: string; type: 'UNAVAILABLE' | 'PREFERRED_OFF'; confidence: number; summary: string }
  | { intent: 'REQUEST_SWAP'; shiftId: string; targetUserId: string; targetUserName: string; reason: string | null; confidence: number; summary: string }
  | { intent: 'REQUEST_TIME_OFF'; startDate: string; endDate: string; reason: string | null; confidence: number; summary: string }
  | { intent: 'APPROVE_SWAP'; swapRequestId: string; confidence: number; summary: string }
  | { intent: 'DECLINE_SWAP'; swapRequestId: string; confidence: number; summary: string }
  | { intent: 'APPROVE_JOIN'; joinRequestId: string; confidence: number; summary: string }
  | { intent: 'DECLINE_JOIN'; joinRequestId: string; confidence: number; summary: string }
  | {
      intent: 'CREATE_SHIFT';
      roleId: string;
      date: string;
      start: string;
      end: string;
      /** A split shift: a second shift the same day, created with the first on one Confirm. */
      second?: { start: string; end: string };
      userId: string | null;
      targetUserName?: string;
      confidence: number;
      summary: string;
    }
  | { intent: 'EDIT_SHIFT'; shiftId: string; roleId?: string; date?: string; start?: string; end?: string; userId?: string | null; targetUserName?: string; confidence: number; summary: string }
  | { intent: 'CANCEL_SHIFT'; shiftId: string; confidence: number; summary: string }
  | { intent: 'ASSIGN_SECTION'; sectionId: string; staffId: string; shiftDate: string; period: 'AM' | 'PM'; dutyLabel: string | null; targetUserName?: string; confidence: number; summary: string }
  | {
      intent: 'PUBLISH_ROTA';
      weekStart: string;
      /** Shifts this publish changes (new or edited since the last publish) and the people it notifies. */
      counts?: { shiftsChanging: number; peopleNotified: number };
      /** What the publish acts on (rotaActions.publishFingerprint): Confirm publishes only if it still matches. */
      fingerprint?: string;
      confidence: number;
      summary: string;
    }
  | { intent: 'APPLY_ROTA_TEMPLATE'; templateId: string | null; templateName: string; weekStart: string; confidence: number; summary: string }
  | {
      intent: 'POST_ANNOUNCEMENT';
      content: string;
      /** How many people are notified, and a fingerprint of who (communicationActions.announcementAudience). */
      recipients?: number;
      fingerprint?: string;
      confidence: number;
      summary: string;
    }
  | { intent: 'POST_SHOUTOUT'; targetUserId: string; targetUserName: string; content: string; confidence: number; summary: string };

/** A question answered by the server (no Confirm, never executed). */
export type ReadIntent = { intent: ReadIntentType; answer: ReadAnswer; confidence: number; summary: string };

/** Never by voice: a plain message and where in the app to do it instead. Never executed. */
export type DeclinedIntent = {
  intent: 'DECLINED';
  category: DeclinedCategory;
  message: string;
  screen: { label: string; path: string } | null;
  confidence: number;
  summary: string;
};

/**
 * `person`: the caller named someone the server could not pin down in their own venue — nobody by
 * that name (`missing`), or more than one (`ambiguous`). `options` then holds one complete reading
 * per candidate, if any.
 */
export type PersonQuestion = { heard: string; status: 'missing' | 'ambiguous' };

export type Unrecognized = {
  intent: 'UNRECOGNIZED';
  reason: string;
  summary: string;
  options?: ChoosableIntent[];
  person?: PersonQuestion;
  /** A recognised command missing what it needs (`missing`: field names, "person" for who); the sentence asks for exactly that. */
  incomplete?: { intent: string; missing: string[] };
  /** Nobody by the name said, but close names and no complete reading to offer: the same words with each name, to read again. */
  retry?: { person: string; text: string }[];
  /** Nobody at the venue sounds like the name said: one complete reading per teammate, to pick from. */
  team?: ChoosableIntent[];
};

export type ParsedIntent = (Action & { details?: ReadingDetails }) | ReadIntent | DeclinedIntent | Unrecognized;

/** An intent the caller can pick from a "which did you mean?" list: an action, never a question or a non-answer. */
export type ChoosableIntent = Action & { details?: ReadingDetails };

// ---------------------------------------------------------------------------
// The model's answer: ONE tool and the arguments as heard. No ids, ever: the
// model is never given any (prompts.ts), and the server resolves every name.
// ---------------------------------------------------------------------------

/** What each tool is for, and which arguments it reads. Shown to the model, filtered by role. */
export const TOOL_GUIDE: Record<IntentType | 'DECLINED', { does: string; args: string }> = {
  MARK_AVAILABILITY: {
    does: 'mark the caller unavailable, or preferring a day off, on one day',
    args: 'day, availability, person (only when the words name someone other than the caller, as heard)',
  },
  REQUEST_SWAP: { does: "ask a colleague to cover one of the caller's own shifts", args: 'person (the colleague), day (the shift), start (only if said), reason' },
  REQUEST_TIME_OFF: {
    does: 'the caller asks for time off: one day, or a run of days',
    args: 'day (first day), endDay (last day, if more than one), reason, person (only when the words name someone other than the caller, as heard)',
  },
  QUERY_MY_SCHEDULE: { does: 'answer when the caller themself works (their own shifts only)', args: 'day or week (only if said)' },
  WHO_IS_WORKING: { does: 'say who is working today, tonight, or on a given day', args: 'day, period (only if said)' },
  WHO_IN_SECTION: { does: 'say who is in a floor section on a day', args: 'section, day, period (only if said)' },
  PENDING_REQUESTS: { does: 'list pending swap requests and upcoming time off', args: 'none' },
  RECENT_ANNOUNCEMENTS: { does: 'read out the latest announcements and shout-outs', args: 'none' },
  APPROVE_SWAP: { does: "approve a colleague's pending swap or cover request", args: 'requester (who asked), day (the shift, if said)' },
  DECLINE_SWAP: { does: "decline a colleague's pending swap or cover request", args: 'requester (who asked), day (the shift, if said)' },
  APPROVE_JOIN: { does: 'approve a pending request to join the team', args: 'applicant (their name as said, if said)' },
  DECLINE_JOIN: { does: 'decline a pending request to join the team', args: 'applicant (their name as said, if said)' },
  CREATE_SHIFT: {
    does: 'create a new shift, for a person or open; a split shift has a second part the same day',
    args: 'person (omit for an open shift), role, day, start, end, start2 and end2 (the second part of a split shift)',
  },
  EDIT_SHIFT: {
    does: "change an existing shift's time, day, role or person",
    args: "person (whose shift it is now; omit for an open shift), day (the shift's day), at (the shift's current start, only if said), start/end (new times), newDay, role (new role), newPerson (who takes it over), unassign (true to take the person off)",
  },
  CANCEL_SHIFT: { does: 'remove (cancel) an existing shift', args: 'person (whose shift; omit for an open shift), day, start (only if said)' },
  ASSIGN_SECTION: { does: 'put a person in a floor section for a day and service', args: 'person, section, day, period, duty (an optional duty note)' },
  PUBLISH_ROTA: { does: "publish a week's rota to staff", args: 'week' },
  APPLY_ROTA_TEMPLATE: { does: 'fill a week from a saved rota template', args: 'template (its name as said), week' },
  POST_ANNOUNCEMENT: { does: 'post an announcement to the whole venue', args: 'message' },
  POST_SHOUTOUT: { does: 'give a colleague a shout-out', args: 'person, message' },
  DECLINED: {
    does:
      'anything that is never done by voice: deactivating or deleting people (people_deactivate_delete), roles or permissions (roles_permissions), sign-in phone numbers (signin_phone), deleting an account (account_delete), kiosk links (kiosk_link), AI settings (ai_settings), payroll or WPS (payroll_wps), floor-plan pins (floor_plan_pins), any other setting (other_settings)',
    args: 'category',
  },
};

const str = (description: string) => ({ type: Type.STRING, nullable: true, description });
const ARG_PROPERTIES = {
  person: str('A person as the caller named them, exactly as heard (first name, full name or nickname). "me"/"myself" means the caller. Never complete or correct a name.'),
  personFull: str('Only when the caller said more than a first name: the whole name as heard.'),
  newPerson: str('EDIT_SHIFT: who takes the shift over, as heard.'),
  unassign: { type: Type.BOOLEAN, nullable: true, description: 'EDIT_SHIFT: true when the person is taken off the shift and it is left open.' },
  requester: str('APPROVE_SWAP/DECLINE_SWAP: who asked for the swap, as heard.'),
  applicant: str('APPROVE_JOIN/DECLINE_JOIN: the applicant, as heard.'),
  section: str('A floor section as said ("the bar", "terrace").'),
  role: str('A job role as said ("bartender", "server").'),
  template: str('A saved rota template name as said.'),
  day: str('YYYY-MM-DD, read from the calendar in the instructions.'),
  endDay: str('REQUEST_TIME_OFF: the last day, YYYY-MM-DD.'),
  newDay: str('EDIT_SHIFT: the new day, YYYY-MM-DD.'),
  at: str("EDIT_SHIFT: the existing shift's start, as said, only to tell two shifts apart."),
  start: str('A time exactly as said ("6", "6pm", "half past six", "18:30", "noon"). Never add am/pm or convert it.'),
  end: str('A time exactly as said. Never add am/pm or convert it.'),
  start2: str("Split shift: the second part's start, as said."),
  end2: str("Split shift: the second part's end, as said."),
  period: { type: Type.STRING, enum: ['AM', 'PM'], nullable: true, description: 'AM for morning or lunch; PM for afternoon, evening, night or "tonight".' },
  availability: { type: Type.STRING, enum: ['UNAVAILABLE', 'PREFERRED_OFF'], nullable: true, description: "MARK_AVAILABILITY: UNAVAILABLE for can't work, PREFERRED_OFF for would rather not." },
  week: str('YYYY-MM-DD: the Monday of the week meant, from the calendar.'),
  message: str('POST_ANNOUNCEMENT/POST_SHOUTOUT: the exact words to post, filler words removed, never paraphrased or added to.'),
  reason: str('A reason, if one was given, as said.'),
  duty: str('ASSIGN_SECTION: a duty note, if one was said.'),
  category: { type: Type.STRING, enum: [...DECLINED_CATEGORIES], nullable: true, description: 'DECLINED: which kind of request it is.' },
};
export type ToolArgName = keyof typeof ARG_PROPERTIES;
export const TOOL_ARG_NAMES = Object.keys(ARG_PROPERTIES) as ToolArgName[];

/**
 * The response schema: one tool, its arguments as heard, then the sentences. Every key is required
 * (the ones a tool doesn't use answer null): a model left free to omit keys was seen live dropping
 * a new shift's end and role at high confidence. The tool comes first, then its arguments, and the
 * sentences and confidence last, written once the details are.
 */
function schemaFor(tools: readonly string[]) {
  const args = { type: Type.OBJECT, properties: ARG_PROPERTIES, required: [...TOOL_ARG_NAMES], propertyOrdering: [...TOOL_ARG_NAMES] };
  const reading = {
    tool: { type: Type.STRING, enum: [...tools, 'DECLINED'] },
    args,
    summary: { type: Type.STRING, description: 'One short plain-English sentence saying what was asked for.' },
    confidence: { type: Type.NUMBER, description: 'How sure you are (0 to 1) that this is the tool and arguments the caller meant.' },
  };
  const properties = {
    tool: { type: Type.STRING, enum: [...tools, 'DECLINED', 'UNRECOGNIZED'] },
    args,
    summary: reading.summary,
    confidence: { ...reading.confidence, nullable: true },
    unrecognizedReason: {
      type: Type.STRING,
      nullable: true,
      description: 'When tool is UNRECOGNIZED: one short, friendly sentence to the caller saying what was unclear and what to say instead. Never mention tools, ids, lists or schemas.',
    },
    hasAdditionalRequest: {
      type: Type.BOOLEAN,
      nullable: true,
      description: 'True when the transcript holds more than one distinct request beyond the one in `tool`. Independent of confidence.',
    },
    alternatives: {
      type: Type.ARRAY,
      nullable: true,
      description:
        'Only when confidence is below 0.6 because the words fit two or three different tools (for example approve or decline): up to 2 OTHER complete readings. Null otherwise.',
      items: { type: Type.OBJECT, properties: reading, required: Object.keys(reading), propertyOrdering: Object.keys(reading) },
    },
  };
  const order = Object.keys(properties);
  return { type: Type.OBJECT, properties, required: order, propertyOrdering: order };
}

const STAFF_SCHEMA = schemaFor(STAFF_INTENTS);
const MANAGER_SCHEMA = schemaFor(MANAGER_INTENTS);

export function intentSchemaFor(systemRole: SystemRole) {
  return systemRole === 'STAFF' ? STAFF_SCHEMA : MANAGER_SCHEMA;
}

export function allowedIntentsFor(systemRole: SystemRole): readonly string[] {
  return systemRole === 'STAFF' ? STAFF_INTENTS : MANAGER_INTENTS;
}
