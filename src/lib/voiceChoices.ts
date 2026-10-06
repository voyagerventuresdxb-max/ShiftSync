import type { ParsedIntent } from '@/api/voice';
import { canConfirmVoiceIntent } from '../../shared/voiceIntents';

/**
 * A "which did you mean?" answer as this person may see it: only choices their role can confirm
 * (the server already filters them; this is the same second check the app makes for a single
 * answer) and only actions. Fewer than two left is not a choice: the list is dropped and the
 * sheet asks to rephrase, as for any low-confidence answer.
 */
export function choosableFor(systemRole: string, intent: ParsedIntent): ParsedIntent {
  if (intent.intent !== 'UNRECOGNIZED' || !intent.options) return intent;
  const options = intent.options.filter(
    (o) => o.intent !== 'UNRECOGNIZED' && o.intent !== 'QUERY_MY_SCHEDULE' && canConfirmVoiceIntent(systemRole, o.intent),
  );
  if (options.length >= 2) return { ...intent, options };
  return { intent: 'UNRECOGNIZED', reason: intent.reason, summary: 'Could not confidently resolve this command.' };
}
