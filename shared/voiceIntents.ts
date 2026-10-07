/**
 * Which voice intents each role may run. Shared between the server (the
 * Gemini response schema and the /execute permission check in
 * server/src/voice/intentSchema.ts) and the client (AppShell, which refuses
 * to open the confirm sheet for an intent the signed-in role may not run,
 * before anything is sent to /execute). The server's 403 stays the real
 * guard; this is the same list so the two can never disagree.
 */
/**
 * Questions answered by the server from the venue's own records (never by the model, never
 * executed): no Confirm. Every role may ask them; what each answer contains is scoped to the
 * caller's role and venue on the server (server/src/voice/reads.ts).
 */
export const READ_VOICE_INTENTS = ['QUERY_MY_SCHEDULE', 'WHO_IS_WORKING', 'WHO_IN_SECTION', 'PENDING_REQUESTS', 'RECENT_ANNOUNCEMENTS'] as const;

export const STAFF_INTENTS = ['MARK_AVAILABILITY', 'REQUEST_SWAP', 'REQUEST_TIME_OFF', ...READ_VOICE_INTENTS] as const;

export const MANAGER_INTENTS = [
  ...STAFF_INTENTS,
  'APPROVE_SWAP',
  'DECLINE_SWAP',
  'APPROVE_JOIN',
  'DECLINE_JOIN',
  'CREATE_SHIFT',
  'EDIT_SHIFT',
  'ASSIGN_SECTION',
  'PUBLISH_ROTA',
  'APPLY_ROTA_TEMPLATE',
  'POST_ANNOUNCEMENT',
  'POST_SHOUTOUT',
  'CANCEL_SHIFT',
] as const;

/** True for a question the server answers (`answer` on the parsed intent); it is never confirmed or executed. */
export function isReadVoiceIntent(intent: string): boolean {
  return (READ_VOICE_INTENTS as readonly string[]).includes(intent);
}

export type VoiceRole = 'OWNER' | 'MANAGER' | 'STAFF';

export function allowedVoiceIntentsFor(systemRole: VoiceRole | string): readonly string[] {
  return systemRole === 'STAFF' ? STAFF_INTENTS : MANAGER_INTENTS;
}

/**
 * True when `intent` is something this role may confirm. UNRECOGNIZED is
 * never "allowed": the sheet shows it as not understood, not as forbidden.
 * Unknown roles (a tampered session blob) fail closed.
 */
export function canConfirmVoiceIntent(systemRole: string, intent: string): boolean {
  if (systemRole !== 'OWNER' && systemRole !== 'MANAGER' && systemRole !== 'STAFF') return false;
  return (allowedVoiceIntentsFor(systemRole) as readonly string[]).includes(intent);
}

export const VOICE_ROLE_REFUSAL = 'That command needs a manager or owner account.';

/**
 * True when two sentences on a voice sheet say the same thing — equal, or one inside the other,
 * ignoring case, spacing and punctuation — so the sheet shows it once, not twice.
 */
export function repeatsSentence(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const [x, y] = [norm(a), norm(b)];
  return x !== '' && y !== '' && (x.includes(y) || y.includes(x));
}
