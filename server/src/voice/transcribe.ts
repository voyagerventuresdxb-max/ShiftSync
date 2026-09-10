import { GoogleGenAI, ApiError } from '@google/genai';
import { voiceModel } from './model.js';

export class VoiceTranscriptionError extends Error {
  /** The underlying error (e.g. a Gemini ApiError) that caused this, if any. */
  cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'VoiceTranscriptionError';
    this.cause = cause;
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
export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  const genai = getClient();

  try {
    const response = await genai.models.generateContent({
      model: voiceModel(),
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Transcribe this voice command to plain text. Return ONLY the transcribed words, nothing else — no punctuation commentary, no quotes around it.' },
            { inlineData: { mimeType, data: buffer.toString('base64') } },
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
      throw new VoiceTranscriptionError(`Transcription failed (${err.status ?? 'unknown'}): ${err.message}`, err);
    }
    if (err instanceof VoiceTranscriptionError) throw err;
    throw new VoiceTranscriptionError('Unexpected error while transcribing audio.', err);
  }
}
