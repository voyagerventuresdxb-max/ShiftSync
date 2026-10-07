/**
 * Phrases to try when a command wasn't understood (and in the typed command box): things this
 * person's role can actually do, said the way people say them. Tapping one only fills the box.
 */
const STAFF_EXAMPLES = ['When am I working this week?', "I can't work next Friday", 'Request next Monday to Wednesday off'];

const MANAGER_EXAMPLES = ["Who's working tonight?", 'Add an open bartender shift tomorrow 6pm to 2am', 'Any pending requests?'];

export function voiceExamples(systemRole: string): string[] {
  return systemRole === 'MANAGER' || systemRole === 'OWNER' ? MANAGER_EXAMPLES : STAFF_EXAMPLES;
}
