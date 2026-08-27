import type { SystemRole } from '@prisma/client';
import { Type } from '@google/genai';

/** Staff self-service intents — every one of these must map to a real, already-existing, session-scoped self-service endpoint. */
export const STAFF_INTENTS = ['MARK_AVAILABILITY', 'REQUEST_SWAP'] as const;

/** Manager-tier intents, strictly a superset of STAFF_INTENTS — OWNER and MANAGER share this set (nothing else in this codebase differentiates them). */
export const MANAGER_INTENTS = [
  ...STAFF_INTENTS,
  'APPROVE_SWAP',
  'DECLINE_SWAP',
  'APPROVE_JOIN',
  'DECLINE_JOIN',
] as const;

export type StaffIntentType = (typeof STAFF_INTENTS)[number];
export type ManagerIntentType = (typeof MANAGER_INTENTS)[number];
export type IntentType = ManagerIntentType;

/** Discriminated union the parse-intent endpoint returns and the execute endpoint receives back. */
export type ParsedIntent =
  | { intent: 'MARK_AVAILABILITY'; date: string; type: 'UNAVAILABLE' | 'PREFERRED_OFF'; summary: string }
  | { intent: 'REQUEST_SWAP'; shiftId: string; targetUserId: string; targetUserName: string; reason: string | null; summary: string }
  | { intent: 'APPROVE_SWAP'; swapRequestId: string; summary: string }
  | { intent: 'DECLINE_SWAP'; swapRequestId: string; summary: string }
  | { intent: 'APPROVE_JOIN'; joinRequestId: string; summary: string }
  | { intent: 'DECLINE_JOIN'; joinRequestId: string; summary: string }
  | { intent: 'UNRECOGNIZED'; reason: string; summary: string };

/** Every role's schema also always allows UNRECOGNIZED, so the model has a safe way to say "I couldn't confidently resolve this" instead of guessing. */
function schemaFor(intents: readonly string[]) {
  return {
    type: Type.OBJECT,
    properties: {
      intent: { type: Type.STRING, enum: [...intents, 'UNRECOGNIZED'] },
      date: { type: Type.STRING, nullable: true, description: 'YYYY-MM-DD, for MARK_AVAILABILITY' },
      availabilityType: { type: Type.STRING, enum: ['UNAVAILABLE', 'PREFERRED_OFF'], nullable: true },
      shiftId: { type: Type.STRING, nullable: true, description: 'For REQUEST_SWAP — one of the ids in the provided shift list' },
      targetUserId: { type: Type.STRING, nullable: true, description: 'For REQUEST_SWAP — one of the ids in the provided staff list' },
      targetUserName: { type: Type.STRING, nullable: true },
      reason: { type: Type.STRING, nullable: true },
      swapRequestId: { type: Type.STRING, nullable: true, description: 'For APPROVE_SWAP/DECLINE_SWAP — one of the ids in the provided pending-swaps list' },
      joinRequestId: { type: Type.STRING, nullable: true, description: 'For APPROVE_JOIN/DECLINE_JOIN — one of the ids in the provided pending-joins list' },
      summary: { type: Type.STRING, description: 'One plain-English sentence describing exactly what will happen, for the confirm step' },
      unrecognizedReason: { type: Type.STRING, nullable: true, description: 'Only for intent=UNRECOGNIZED — why this could not be resolved' },
    },
    required: ['intent', 'summary'],
  };
}

const STAFF_SCHEMA = schemaFor(STAFF_INTENTS);
const MANAGER_SCHEMA = schemaFor(MANAGER_INTENTS);

/** Server-side re-derivation point: OWNER and MANAGER both get the manager schema, STAFF gets the smaller one. Called fresh in both /parse-intent and, again, as a permission re-check in /execute. */
export function intentSchemaFor(systemRole: SystemRole) {
  return systemRole === 'STAFF' ? STAFF_SCHEMA : MANAGER_SCHEMA;
}

export function allowedIntentsFor(systemRole: SystemRole): readonly string[] {
  return systemRole === 'STAFF' ? STAFF_INTENTS : MANAGER_INTENTS;
}
