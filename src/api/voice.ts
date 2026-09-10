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
import { ApiError } from './schedules';
import { withAuth } from './identity';
export { ApiError };

export type ParsedIntent =
  | { intent: 'MARK_AVAILABILITY'; date: string; type: 'UNAVAILABLE' | 'PREFERRED_OFF'; summary: string }
  | { intent: 'REQUEST_SWAP'; shiftId: string; targetUserId: string; targetUserName: string; reason: string | null; summary: string }
  | { intent: 'APPROVE_SWAP'; swapRequestId: string; summary: string }
  | { intent: 'DECLINE_SWAP'; swapRequestId: string; summary: string }
  | { intent: 'APPROVE_JOIN'; joinRequestId: string; summary: string }
  | { intent: 'DECLINE_JOIN'; joinRequestId: string; summary: string }
  | { intent: 'UNRECOGNIZED'; reason: string; summary: string };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
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

/** POST /api/voice/parse-intent — body: { transcript }. Never mutates anything — the "propose" half of confirm-before-execute. */
export async function parseVoiceIntent(token: string, transcript: string): Promise<{ transcript: string; intent: ParsedIntent }> {
  return request('/api/voice/parse-intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ transcript }),
  });
}

/**
 * POST /api/voice/execute — body: { transcript, intent }. The "execute" half
 * of confirm-before-execute. The real permission/shape re-validation lives
 * server-side (see server/src/routes/voice.ts) — this client call carries
 * whatever intent /parse-intent returned, unmodified.
 */
export async function executeVoiceIntent(
  token: string,
  transcript: string,
  intent: ParsedIntent,
): Promise<{ executed: boolean; result: unknown }> {
  return request('/api/voice/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withAuth(token) },
    body: JSON.stringify({ transcript, intent }),
  });
}
