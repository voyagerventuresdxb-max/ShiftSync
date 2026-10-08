import { isReadIntent, type ParsedIntent } from '@/api/voice';
import { canConfirmVoiceIntent } from '../../shared/voiceIntents';

/**
 * A "which did you mean?" answer as this person may see it: only choices their role can confirm
 * (the server already filters them; this is the same second check the app makes for a single
 * answer) and only actions. For a choice between readings, fewer than two left is not a choice:
 * the list is dropped and the sheet asks to rephrase, as for any low-confidence answer. A question
 * about a person ("Which Karim?", "I couldn't find Rana — did you mean Rania?") keeps even a single
 * suggestion, since the question itself stands without it.
 */
export function choosableFor(systemRole: string, intent: ParsedIntent): ParsedIntent {
  if (intent.intent !== 'UNRECOGNIZED') return intent;
  const allowed = (o: ParsedIntent) => o.intent !== 'UNRECOGNIZED' && o.intent !== 'DECLINED' && !isReadIntent(o) && canConfirmVoiceIntent(systemRole, o.intent);
  // "Pick from your team": the same check, list by list.
  if (intent.team) {
    const copy = { ...intent, team: intent.team.filter(allowed) };
    if (!copy.team.length) delete (copy as { team?: unknown }).team;
    intent = copy;
  }
  const team = intent.team ? { team: intent.team } : {};
  if (!intent.options) return intent;
  const options = intent.options.filter(allowed);
  if (options.length >= (intent.person ? 1 : 2)) return { ...intent, options };
  if (intent.person) {
    // Its reason pointed at choices that are gone now.
    const reason = intent.person.status === 'missing' ? 'Check the name and try again.' : 'Say their full name and try again.';
    return { intent: 'UNRECOGNIZED', reason, summary: intent.summary, person: intent.person, ...team };
  }
  return { intent: 'UNRECOGNIZED', reason: 'Say it again, or fix what I heard and try again.', summary: "I'm not sure I got that right." };
}
