/**
 * Which voice intents each role may run. Shared between the server (the
 * Gemini response schema and the /execute permission check in
 * server/src/voice/intentSchema.ts) and the client (AppShell, which refuses
 * to open the confirm sheet for an intent the signed-in role may not run,
 * before anything is sent to /execute). The server's 403 stays the real
 * guard; this is the same list so the two can never disagree.
 */
export const STAFF_INTENTS = ['MARK_AVAILABILITY', 'REQUEST_SWAP', 'QUERY_MY_SCHEDULE'] as const;

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
] as const;

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
