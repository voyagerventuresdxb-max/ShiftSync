import { useState } from 'react';
import { runAiSelfTest, type AiSelfTestCheck, type AiSelfTestReason, type AiSelfTestResult } from '../api/ai';

const REASONS: Record<AiSelfTestReason, string> = {
  not_configured: "isn't set up on this server.",
  credentials: "the server's Google credentials can't be read.",
  access_denied: "Google refused the server's credentials (check the service account's Vertex AI access).",
  model_unavailable: "the configured AI model isn't available.",
  paused_today: "today's limit is reached; it's back tomorrow.",
  paused_month: "this month's AI spending limit is reached.",
  unavailable: "Google didn't answer; try again in a few minutes.",
  failed: 'the test call failed.',
};

function describe(check: AiSelfTestCheck): string {
  if (!check.ok) return `Not working — ${REASONS[check.reason ?? 'failed']}`;
  const where = check.backend === 'vertex' ? `Vertex AI, ${check.location}` : 'Gemini API';
  return `Working — ${check.model} (${where}), ${check.latencyMs} ms`;
}

/** Owner-only: runs POST /api/ai/self-test and shows one line per AI feature. */
export default function AiConnectionPanel({ token }: { token: string }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AiSelfTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await runAiSelfTest(token));
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : 'Could not test the AI connection. Try again.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="panel p-5" data-testid="ai-connection">
      <p className="eyebrow">AI connection</p>
      <p className="text-sm text-muted-foreground">
        Sends one tiny test to roster photo reading and one to voice commands. Each counts as a call against your AI limits.
      </p>
      <button className="btn btn-ghost mt-3 hit-44" onClick={run} disabled={running}>
        {running ? 'Testing…' : 'Test AI connection'}
      </button>
      {result && (
        <ul className="mt-3 space-y-1 text-sm" aria-live="polite">
          <li>
            <span className="font-semibold">Roster photo reading:</span> {describe(result.vision)}
          </li>
          <li>
            <span className="font-semibold">Voice commands:</span> {describe(result.voice)}
          </li>
        </ul>
      )}
      {error && (
        <p className="error-block mt-3" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
