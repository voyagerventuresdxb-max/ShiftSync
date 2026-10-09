/**
 * Client for the Voice Command API (server/src/routes/voice.ts) — the
 * transcribe -> parse-intent -> execute pipeline behind the mic button.
 *
 * `ParsedIntent` is mirrored here rather than imported from
 * `server/src/voice/intentSchema.ts`. A type-only cross-package import was
 * verified to compile cleanly under both `tsc --noEmit` (this project's
 * `npm run typecheck`) and `tsc -b` (the first step of `npm run build`) in
 * this repo's actual tsconfig setup — including a real discriminated-union
 * narrowing check, not just a structural pass-through. It was still not
 * used: every other client in `src/api/*.ts` (schedules.ts, identity.ts,
 * availability.ts, myShifts.ts) defines its own DTO shape instead of
 * reaching across the client/server boundary, and this file follows that
 * same established convention rather than being the one exception. Keep
 * this union in sync with intentSchema.ts's `ParsedIntent` by hand if that
 * file changes.
 */
import { apiFetch } from './http';
import { ApiError } from './schedules';
import { withAuth } from './identity';
import { apiUrl } from '../lib/apiUrl';
export { ApiError };

/** Names for the confirm sheet's preview, written by the server from the caller's own venue (never by the model). */
export interface ReadingDetails {
  person?: string | null;
  /** That person's own role at the venue, shown next to their name. */
  personRole?: string | null;
  cover?: string | null;
  role?: string;
  section?: string;
  shift?: { date: string; start: string; end: string; role?: string; person?: string | null };
}

type Action =
  | { intent: 'MARK_AVAILABILITY'; date: string; type: 'UNAVAILABLE' | 'PREFERRED_OFF'; confidence: number; summary: string }
  | { intent: 'REQUEST_SWAP'; shiftId: string; targetUserId: string; targetUserName: string; reason: string | null; confidence: number; summary: string }
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
      userId: string | null;
      targetUserName?: string;
      /** A split shift: a second segment on the same day, created by the same Confirm. */
      second?: { start: string; end: string };
      confidence: number;
      summary: string;
    }
  | { intent: 'EDIT_SHIFT'; shiftId: string; roleId?: string; date?: string; start?: string; end?: string; userId?: string | null; targetUserName?: string; confidence: number; summary: string }
  | { intent: 'ASSIGN_SECTION'; sectionId: string; staffId: string; shiftDate: string; period: 'AM' | 'PM'; dutyLabel: string | null; targetUserName?: string; confidence: number; summary: string }
  | {
      intent: 'PUBLISH_ROTA';
      weekStart: string;
      /** Only the shifts this publish actually changes, and only the people who will be notified (absent from older servers). */
      counts?: { shiftsChanging: number; peopleNotified: number };
      /** What the publish acts on; sent back with Confirm, which publishes only if nothing changed since (absent from older servers). */
      fingerprint?: string;
      confidence: number;
      summary: string;
    }
  | { intent: 'APPLY_ROTA_TEMPLATE'; templateId: string | null; templateName: string; weekStart: string; confidence: number; summary: string }
  | {
      intent: 'POST_ANNOUNCEMENT';
      content: string;
      /** How many people the server says are notified, and who (absent from older servers). */
      recipients?: number;
      fingerprint?: string;
      confidence: number;
      summary: string;
    }
  | { intent: 'POST_SHOUTOUT'; targetUserId: string; targetUserName: string; content: string; confidence: number; summary: string }
  | { intent: 'REQUEST_TIME_OFF'; startDate: string; endDate: string; reason: string | null; confidence: number; summary: string };

/** A read the server answered from its own lookups: shown as a list, never confirmed or executed. Every string is untrusted text. */
export interface VoiceAnswer {
  /** e.g. "Working tonight — Thursday 8 October 2026". */
  title: string;
  items: Array<{ primary: string; secondary?: string; tertiary?: string }>;
  /** Shown when `items` is empty. */
  emptyText: string;
}

export const READ_VOICE_INTENTS = ['WHO_IS_WORKING', 'WHO_IN_SECTION', 'PENDING_REQUESTS', 'RECENT_ANNOUNCEMENTS', 'QUERY_MY_SCHEDULE'] as const;
export type ReadVoiceIntent = (typeof READ_VOICE_INTENTS)[number];

type Read =
  /** Older servers answer QUERY_MY_SCHEDULE in `summary` alone, without `answer`. */
  | { intent: 'QUERY_MY_SCHEDULE'; answer?: VoiceAnswer; confidence: number; summary: string }
  | { intent: Exclude<ReadVoiceIntent, 'QUERY_MY_SCHEDULE'>; answer: VoiceAnswer; confidence: number; summary: string };

/** Something never done by voice: the server's own message, and the screen where it is done. */
export interface DeclinedIntent {
  intent: 'DECLINED';
  category: string;
  message: string;
  /** `label` is a bare screen name ("People"); `path` an in-app route. */
  screen: { label: string; path: string } | null;
  summary: string;
  confidence: number;
}

/** Cancelling a shift: the preview needs the shift itself, so `details` always comes with it. */
export interface CancelShiftIntent {
  intent: 'CANCEL_SHIFT';
  shiftId: string;
  confidence: number;
  summary: string;
  details: { person: string | null; personRole: string | null; date: string; start: string; end: string; role: string | null };
}

export type ParsedIntent =
  | (Action & { details?: ReadingDetails })
  | CancelShiftIntent
  | Read
  | DeclinedIntent
  /**
   * `options`: complete, checked readings to choose from — below the confidence threshold ("which
   * did you mean?"), or one per person when the name said fits nobody or more than one person at
   * the venue (`person`).
   */
  /** `incomplete`: a recognised command missing parts it needs; `summary` asks for exactly those. */
  | {
      intent: 'UNRECOGNIZED';
      reason: string;
      summary: string;
      options?: ParsedIntent[];
      person?: { heard: string; status: 'missing' | 'ambiguous' };
      incomplete?: { intent: string; missing: string[] };
      /** Nobody by the name said, but close names: the same words with each name, to read again. */
      retry?: { person: string; text: string }[];
      /** Nobody at the venue sounds like the name said: one complete reading per teammate, to pick from. */
      team?: ParsedIntent[];
    };

/** The server's answer for a read, or null for anything else (including an older QUERY_MY_SCHEDULE). */
export function voiceAnswer(intent: ParsedIntent): VoiceAnswer | null {
  return 'answer' in intent && intent.answer ? intent.answer : null;
}

/** Reads are answered, never confirmed or executed. */
export function isReadIntent(intent: ParsedIntent): boolean {
  return (READ_VOICE_INTENTS as readonly string[]).includes(intent.intent);
}

/** The person (and their role) a reading is about, from the server's names; null when it names nobody. */
export function readingPerson(intent: ParsedIntent): { name: string; role: string | null } | null {
  const d = 'details' in intent ? intent.details : undefined;
  return d?.person ? { name: d.person, role: d.personRole ?? null } : null;
}

/** How long a voice call may take before the app stops waiting (the model can hang; the person shouldn't). */
export const VOICE_TIMEOUT_MS = 25_000;

/**
 * The client timeout for voice calls: 25 s, unless a test set `window.__shiftsyncVoiceTimeoutMs`
 * before the app loaded (e2e/voice-ui.spec.ts does, so its timeout case runs in about a second).
 */
export function voiceTimeoutMs(): number {
  const override = (globalThis as { __shiftsyncVoiceTimeoutMs?: unknown }).__shiftsyncVoiceTimeoutMs;
  return typeof override === 'number' && override > 0 ? override : VOICE_TIMEOUT_MS;
}

/** The app stopped waiting for a voice call (see `voiceTimeoutMs`). The server may still have finished it. */
export class VoiceTimeoutError extends Error {
  constructor(public readonly seconds: number) {
    super(`No answer after ${seconds} seconds.`);
    this.name = 'VoiceTimeoutError';
  }
}

/** No connection: the phone says it is offline (`sent` false: nothing left the phone), or the request never got an answer. */
export class VoiceOfflineError extends Error {
  constructor(public readonly sent: boolean) {
    super(sent ? 'Could not reach ShiftSync.' : 'Offline: nothing was sent.');
    this.name = 'VoiceOfflineError';
  }
}

/**
 * Every voice call: never sent while the phone is offline, aborted after `voiceTimeoutMs()`, and a
 * network failure told apart from a server answer (VoiceOfflineError / VoiceTimeoutError / ApiError).
 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new VoiceOfflineError(false);
  const timeoutMs = voiceTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await apiFetch(apiUrl(url), { ...init, signal: controller.signal });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      let errorCode: string | undefined;
      try {
        const body = (await res.json()) as { error?: string; errorCode?: string };
        if (body?.error) message = body.error;
        errorCode = body?.errorCode;
      } catch {
        // non-JSON error body; keep the generic message
      }
      throw new ApiError(message, res.status, undefined, errorCode);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (controller.signal.aborted) throw new VoiceTimeoutError(Math.round(timeoutMs / 1000));
    // fetch rejects with a TypeError when the request got no answer at all (no network, DNS, a dropped connection).
    if (err instanceof TypeError) throw new VoiceOfflineError(true);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Cosmetic filename only — the server reads the real mimetype off the upload's own Content-Type (i.e. the recorded Blob's `.type`), not this extension. */
function filenameFor(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'command.ogg';
  if (mimeType.includes('wav')) return 'command.wav';
  if (mimeType.includes('mp4')) return 'command.mp4';
  if (mimeType.includes('aac')) return 'command.aac';
  return 'command.webm';
}

/**
 * POST /api/voice/transcribe — multipart: audio. Session-gated.
 * `audioBlob.type` (set by the caller's MediaRecorder) is what the server
 * actually sees as the upload's mimetype.
 */
export async function transcribeAudio(token: string, audioBlob: Blob): Promise<{ transcript: string }> {
  const form = new FormData();
  form.append('audio', audioBlob, filenameFor(audioBlob.type));
  return request('/api/voice/transcribe', {
    method: 'POST',
    headers: withAuth(token),
    body: form,
  });
}

/**
 * POST /api/voice/parse-intent — body: { transcript, source }. Never mutates anything — the
 * "propose" half of confirm-before-execute. `source` is 'typed' for words the person typed or
 * edited (nothing recorded), 'voice' for a transcript.
 */
export async function parseVoiceIntent(
  token: string,
  transcript: string,
  source: 'voice' | 'typed' = 'voice',
): Promise<{ transcript: string; intent: ParsedIntent; voiceLogId: string | null; hasAdditionalRequest: boolean }> {
  return request('/api/voice/parse-intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ transcript, source }),
  });
}

/**
 * POST /api/voice/execute — body: { transcript, intent, voiceLogId }. The
 * "execute" half of confirm-before-execute. The real permission/shape
 * re-validation lives server-side (see server/src/routes/voice.ts) — this
 * client call carries whatever intent /parse-intent returned, unmodified.
 */
export async function executeVoiceIntent(
  token: string,
  transcript: string,
  intent: ParsedIntent,
  voiceLogId: string | null,
  /** One per preview: the server runs a Confirm with the same key only once (older servers ignore it). */
  idempotencyKey?: string,
): Promise<{ executed: boolean; result: unknown }> {
  return request('/api/voice/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ transcript, intent, voiceLogId, ...(idempotencyKey ? { idempotencyKey } : {}) }),
  });
}
