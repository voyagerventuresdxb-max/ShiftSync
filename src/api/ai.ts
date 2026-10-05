/** Client for the owner-only AI routes (server/src/routes/ai.ts). */
import { apiFetch } from './http';
import { ApiError } from './schedules';
import { withAuth } from './identity';
import { apiUrl } from '../lib/apiUrl';

export type AiSelfTestReason =
  | 'not_configured'
  | 'credentials'
  | 'access_denied'
  | 'model_unavailable'
  | 'paused_today'
  | 'paused_month'
  | 'unavailable'
  | 'failed';

export interface AiSelfTestCheck {
  ok: boolean;
  backend: 'vertex' | 'developer-api' | null;
  model: string;
  location: string | null;
  latencyMs: number | null;
  reason?: AiSelfTestReason;
}

export interface AiSelfTestResult {
  vision: AiSelfTestCheck;
  voice: AiSelfTestCheck;
}

/** POST /api/ai/self-test — one tiny real call per AI feature, through the spend cap. Owners only. */
export async function runAiSelfTest(token: string): Promise<AiSelfTestResult> {
  const res = await apiFetch(apiUrl('/api/ai/self-test'), { method: 'POST', headers: withAuth(token) });
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
  return (await res.json()) as AiSelfTestResult;
}
