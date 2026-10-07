import { createServer } from 'node:http';

/**
 * A stand-in for the Gemini API, so voice e2e runs the real API pipeline
 * (/transcribe → /parse-intent → /execute) with no key and no quota. The API
 * reaches it through GEMINI_BASE_URL (playwright.config.ts), which only the
 * voice clients read. A spec scripts each utterance — the transcription text
 * and the raw intent JSON the model would return — before tapping the mic.
 * Started as a Playwright webServer; this file is also imported by specs for
 * the client helpers below.
 */
export const FAKE_GEMINI_PORT = 4599;
export const FAKE_GEMINI_URL = `http://127.0.0.1:${FAKE_GEMINI_PORT}`;

export type GeminiCall = { kind: 'transcribe' | 'parse'; body: GenerateContentBody };
type GenerateContentBody = {
  contents?: { parts?: { text?: string; inlineData?: { mimeType: string; data: string } }[] }[];
  systemInstruction?: unknown;
  generationConfig?: { responseMimeType?: string; responseSchema?: unknown; responseJsonSchema?: unknown };
};

/** Queues one utterance: what transcription returns, then what intent parsing returns. */
export async function scriptUtterance(transcript: string, intent: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${FAKE_GEMINI_URL}/__script`, { method: 'POST', body: JSON.stringify({ transcript, intent }) });
  if (!res.ok) throw new Error(`fake Gemini /__script failed: ${res.status}`);
}

/** Queues only an intent answer: a parse of typed text (the sheet's "Try again"), with no recording to transcribe. */
export async function scriptIntent(intent: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${FAKE_GEMINI_URL}/__script`, { method: 'POST', body: JSON.stringify({ intent }) });
  if (!res.ok) throw new Error(`fake Gemini /__script failed: ${res.status}`);
}

export async function resetFakeGemini(): Promise<void> {
  await fetch(`${FAKE_GEMINI_URL}/__reset`, { method: 'POST' });
}

/** Every generateContent call the API made since the last reset, oldest first. */
export async function geminiCalls(): Promise<GeminiCall[]> {
  return (await (await fetch(`${FAKE_GEMINI_URL}/__calls`)).json()) as GeminiCall[];
}

function serve(): void {
  const transcripts: string[] = [];
  const intents: Record<string, unknown>[] = [];
  const calls: GeminiCall[] = [];

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/__health') return json(200, { ok: true });
      if (req.method === 'GET' && url === '/__calls') return json(200, calls);
      if (req.method === 'POST' && url === '/__reset') {
        transcripts.length = 0;
        intents.length = 0;
        calls.length = 0;
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && url === '/__script') {
        const { transcript, intent } = JSON.parse(raw) as { transcript?: string; intent: Record<string, unknown> };
        if (transcript !== undefined) transcripts.push(transcript);
        intents.push(intent);
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && /\/models\/[^/]+:generateContent$/.test(url)) {
        const body = JSON.parse(raw) as GenerateContentBody;
        // Intent parsing is the only call with a system prompt and a JSON response schema.
        const kind = body.systemInstruction || body.generationConfig?.responseMimeType === 'application/json' ? 'parse' : 'transcribe';
        calls.push({ kind, body });
        const next = kind === 'parse' ? intents.shift() : transcripts.shift();
        if (next === undefined) {
          return json(500, { error: { code: 500, status: 'INTERNAL', message: `fake Gemini: no ${kind} response scripted` } });
        }
        const text = typeof next === 'string' ? next : JSON.stringify(next);
        return json(200, { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }] });
      }
      return json(404, { error: { code: 404, status: 'NOT_FOUND', message: `fake Gemini: no route for ${req.method} ${url}` } });
    });
  });
  server.listen(FAKE_GEMINI_PORT, '127.0.0.1', () => console.log(`[fake-gemini] listening on ${FAKE_GEMINI_URL}`));
}

// playwright.config.ts starts it with --serve; specs import this file for the helpers only.
if (process.argv.includes('--serve')) serve();
