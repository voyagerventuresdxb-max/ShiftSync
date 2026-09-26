import { GoogleGenAI, ApiError } from '@google/genai';
import { voiceModel } from './model.js';

/**
 * Why transcription failed, so the route can answer differently:
 *  - format_rejected  Gemini refused the audio itself (400/415) — a bug in
 *                     what we send (a mimetype it doesn't take), not an outage.
 *  - unavailable      quota (429), overload (5xx), auth/config, network, or
 *                     an empty answer — retry later.
 */
export type VoiceFailureKind = 'format_rejected' | 'unavailable';

export class VoiceTranscriptionError extends Error {
  /** The underlying error (e.g. a Gemini ApiError) that caused this, if any. */
  cause?: unknown;
  kind: VoiceFailureKind;

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
  if (!process.env.GEMINI_API_KEY) {
    throw new VoiceTranscriptionError('GEMINI_API_KEY is not configured on the server — voice transcription is unavailable.');
  }
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
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
export async function transcribeAudio(buffer: Buffer, mimeType: string, vocabularyHint?: string): Promise<string> {
  const genai = getClient();
  const sentAs = geminiMimeTypeFor(mimeType);
  // Always logged: when a phone's format is rejected this line is the
  // evidence of what that phone actually recorded.
  console.log(`[voice.transcribe] mime=${mimeType} sent-as=${sentAs} bytes=${buffer.length}`);

  const instruction = vocabularyHint
    ? `Transcribe this voice command to plain text. Return ONLY the transcribed words, nothing else — no punctuation commentary, no quotes around it. This is a hospitality-venue staff-scheduling command; it may reference these names/terms — bias your transcription toward them when the audio is ambiguous: ${vocabularyHint}`
    : 'Transcribe this voice command to plain text. Return ONLY the transcribed words, nothing else — no punctuation commentary, no quotes around it.';

  try {
    const response = await genai.models.generateContent({
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
    });
    const text = response.text?.trim();
    if (!text) {
      throw new VoiceTranscriptionError('Gemini returned an empty transcription.');
    }
    return text;
  } catch (err) {
    if (err instanceof ApiError) {
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
