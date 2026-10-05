import { GoogleGenAI, ApiError, ThinkingLevel } from '@google/genai';
import { reportIfModelUnavailable, voiceClientOptions, voiceModel } from './model.js';
import { AiBudgetExceededError, MAX_OUTPUT_TOKENS, audioInputEstimate, withAiBudget } from '../lib/aiBudget.js';
import { billedOutputTokens } from '../parsing/visionProvider.js';

/**
 * Why transcription failed, so the route can answer differently:
 *  - format_rejected    Gemini refused the audio itself (400/415) — a bug in
 *                       what we send (a mimetype it doesn't take), not an outage.
 *  - model_unavailable  Gemini answered 404 for the configured model (retired or
 *                       misspelled) — an operator fix, not a retry.
 *  - unavailable        quota (429), overload (5xx), auth/config, network, or
 *                       an empty answer — retry later.
 *  - not_configured     no AI backend is set on this server (no Vertex project, no key).
 *  - paused             the in-app spend cap refused the call (see `limit`); nothing was sent.
 */
export type VoiceFailureKind = 'format_rejected' | 'model_unavailable' | 'unavailable' | 'paused' | 'not_configured';

export class VoiceTranscriptionError extends Error {
  /** The underlying error (e.g. a Gemini ApiError) that caused this, if any. */
  cause?: unknown;
  kind: VoiceFailureKind;
  /** For kind 'paused': which limit refused the call. */
  limit?: AiBudgetExceededError['limit'];

  constructor(message: string, cause?: unknown, kind: VoiceFailureKind = 'unavailable') {
    super(message);
    this.name = 'VoiceTranscriptionError';
    this.cause = cause;
    this.kind = kind;
    // Preserve the original stack so the server log shows the real failure
    // point instead of only the wrapper's message.
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (client) return client;
  let options: ReturnType<typeof voiceClientOptions>;
  try {
    options = voiceClientOptions();
  } catch (err) {
    throw new VoiceTranscriptionError(err instanceof Error ? err.message : 'Voice AI credentials could not be read.', err);
  }
  if (!options) {
    throw new VoiceTranscriptionError(
      'No AI backend is configured (GEMINI_VERTEX_PROJECT or GEMINI_API_KEY) — voice transcription is unavailable.',
      undefined,
      'not_configured',
    );
  }
  client = new GoogleGenAI(options);
  return client;
}

/** Test seam: swap the Gemini client so format/quota failures can be simulated without a network call. Pass null to restore. */
export function __setVoiceClientForTests(fake: GoogleGenAI | null): void {
  client = fake;
}

/**
 * The mimetype we actually put on the inlineData part. iPhone Safari's
 * MediaRecorder produces `audio/mp4` (AAC in an MP4 container), which is not
 * in Gemini's documented audio list — but `video/mp4` is in its video list
 * and is the same container, so an audio-only MP4 goes through labelled as
 * video. Codec parameters (";codecs=…") are dropped for every type: Gemini
 * wants a bare media type. Everything else passes through unchanged.
 */
export function geminiMimeTypeFor(mimeType: string): string {
  const base = mimeType.split(';')[0]!.trim().toLowerCase();
  if (base === 'audio/mp4' || base === 'audio/x-m4a' || base === 'audio/m4a') return 'video/mp4';
  return base;
}

/**
 * A 400/415 from Gemini on a transcription call means it did not accept the
 * request we built — for this endpoint that is the audio format (nothing
 * else in the request varies per phone). Anything else is "try later".
 */
export function classifyGeminiFailure(err: ApiError): VoiceFailureKind {
  if (err.status === 404) return 'model_unavailable';
  return err.status === 400 || err.status === 415 ? 'format_rejected' : 'unavailable';
}

/**
 * Transcribes a short voice-command audio clip to plain text via Gemini.
 *
 * @param buffer    Raw audio bytes.
 * @param mimeType  The audio's MIME type. Gemini's `generateContent` inline-audio
 *   input officially supports: audio/wav, audio/mp3, audio/aiff, audio/aac,
 *   audio/ogg, audio/flac (per https://ai.google.dev/gemini-api/docs/audio).
 *   Notably audio/webm is NOT among Gemini's documented supported audio
 *   formats — callers recording via the browser MediaRecorder API (which
 *   defaults to audio/webm) should transcode to one of the supported types
 *   before calling this function, or verify behavior empirically, since an
 *   unsupported mimetype will surface as a Gemini ApiError below.
 */
export async function transcribeAudio(buffer: Buffer, mimeType: string, vocabularyHint?: string, locationId: string | null = null): Promise<string> {
  const genai = getClient();
  const sentAs = geminiMimeTypeFor(mimeType);
  // Always logged: when a phone's format is rejected this line is the
  // evidence of what that phone actually recorded.
  console.log(`[voice.transcribe] mime=${mimeType} sent-as=${sentAs} bytes=${buffer.length}`);

  const instruction = vocabularyHint
    ? `Transcribe this voice command to plain text. Return ONLY the transcribed words, nothing else — no punctuation commentary, no quotes around it. This is a hospitality-venue staff-scheduling command; it may reference these names/terms — bias your transcription toward them when the audio is ambiguous: ${vocabularyHint}`
    : 'Transcribe this voice command to plain text. Return ONLY the transcribed words, nothing else — no punctuation commentary, no quotes around it.';

  try {
    const response = await withAiBudget(
      { locationId, feature: 'voice_transcribe', inputTokensEstimate: audioInputEstimate(buffer.length) + Math.ceil(instruction.length / 3) },
      async () => {
        const r = await genai.models.generateContent({
          model: voiceModel(),
          contents: [
            {
              role: 'user',
              parts: [
                { text: instruction },
                { inlineData: { mimeType: sentAs, data: buffer.toString('base64') } },
              ],
            },
          ],
          config: { maxOutputTokens: MAX_OUTPUT_TOKENS.voice_transcribe, thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } },
        });
        return { value: r, usage: { inputTokens: r.usageMetadata?.promptTokenCount ?? null, outputTokens: billedOutputTokens(r.usageMetadata) } };
      },
    );
    const text = response.text?.trim();
    if (!text) {
      throw new VoiceTranscriptionError('Gemini returned an empty transcription.');
    }
    return text;
  } catch (err) {
    if (err instanceof AiBudgetExceededError) {
      const paused = new VoiceTranscriptionError(`AI spend cap reached (${err.limit}); no call made.`, err, 'paused');
      paused.limit = err.limit;
      throw paused;
    }
    if (err instanceof ApiError) {
      reportIfModelUnavailable('transcribe', err);
      const kind = classifyGeminiFailure(err);
      throw new VoiceTranscriptionError(
        `Transcription failed (${err.status ?? 'unknown'}, ${kind}, mime=${mimeType} sent-as=${sentAs}): ${err.message}`,
        err,
        kind,
      );
    }
    if (err instanceof VoiceTranscriptionError) throw err;
    throw new VoiceTranscriptionError('Unexpected error while transcribing audio.', err);
  }
}
