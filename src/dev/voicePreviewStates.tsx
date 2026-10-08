import type { ComponentProps } from 'react';
import type { ParsedIntent } from '@/api/voice';
import type { VoiceCommandSheet } from '@/components/shiftsync/VoiceCommandSheet';
import { micProblem, offlineProblem, requestProblem } from '@/lib/voiceErrors';
import { VoiceTimeoutError } from '@/api/voice';
import type { VoiceStageState } from '@/lib/voiceStage';

/**
 * DEVELOPMENT ONLY: every state of the voice sheet with made-up people (Alex Example, Sam Sample,
 * Karim Saleh, Karim Aziz) and a made-up venue, for the /dev/voice preview and its screenshots.
 */

type SheetProps = Omit<ComponentProps<typeof VoiceCommandSheet>, 'onConfirm' | 'onChoose' | 'onReparse' | 'onCancel' | 'onBackToChoices'> & { backToChoices?: boolean };

export interface PreviewState {
  state: VoiceStageState;
  heard: string;
  composerText: string;
  sheet?: SheetProps;
}

export const PREVIEW_VENUE = 'The Example Room';
export const PREVIEW_VIEWER = 'Jordan Demo';

const idle: VoiceStageState = {
  starting: false,
  recording: false,
  phase: null,
  hiddenWhileBusy: false,
  composer: { open: false, problem: null, sending: false },
  result: null,
  executing: false,
  reparsing: false,
};

const SAID = 'Give Alex a shout-out for handling the rush tonight';

const shoutout: ParsedIntent = {
  intent: 'POST_SHOUTOUT',
  targetUserId: 'u1',
  targetUserName: 'Alex Example',
  content: 'Great job handling the rush tonight',
  confidence: 0.95,
  summary: 'Give Alex Example a shout-out with this note.',
  details: { person: 'Alex Example', personRole: 'Bartender' },
};

const shift: ParsedIntent = {
  intent: 'CREATE_SHIFT',
  roleId: 'r1',
  date: '2026-10-09',
  start: '18:30',
  end: '01:00',
  userId: 'u1',
  confidence: 0.94,
  summary: 'Create a Bartender shift for Alex Example on Friday, 18:30 to 01:00.',
  details: { person: 'Alex Example', personRole: 'Bartender', role: 'Bartender' },
};

const cancel: ParsedIntent = {
  intent: 'CANCEL_SHIFT',
  shiftId: 's1',
  confidence: 0.93,
  summary: "Cancel Sam Sample's Saturday Server shift.",
  details: { person: 'Sam Sample', personRole: 'Server', date: '2026-10-10', start: '12:00', end: '20:00', role: 'Server' },
};

const publish: ParsedIntent = {
  intent: 'PUBLISH_ROTA',
  weekStart: '2026-10-12',
  counts: { shiftsChanging: 12, peopleNotified: 8 },
  confidence: 0.95,
  summary: 'Publish the rota for the week of 12 October.',
};

const assign: ParsedIntent = {
  intent: 'ASSIGN_SECTION',
  sectionId: 'sec1',
  staffId: 'u2',
  shiftDate: '2026-10-09',
  period: 'PM',
  dutyLabel: null,
  confidence: 0.92,
  summary: 'Put Sam Sample on the Terrace, Friday evening.',
  details: { person: 'Sam Sample', personRole: 'Server', section: 'Terrace' },
};

const timeOff: ParsedIntent = {
  intent: 'REQUEST_TIME_OFF',
  startDate: '2026-10-12',
  endDate: '2026-10-14',
  reason: 'Family visit',
  confidence: 0.9,
  summary: 'Request time off from 12 to 14 October.',
};

const karim = (name: string, role: string): ParsedIntent => ({
  intent: 'POST_SHOUTOUT',
  targetUserId: name,
  targetUserName: name,
  content: 'Well done',
  confidence: 0.9,
  summary: `Give ${name} a shout-out.`,
  details: { person: name, personRole: role },
});

const whichOne: ParsedIntent = {
  intent: 'UNRECOGNIZED',
  reason: 'Two people at your venue are called Karim.',
  summary: 'Which Karim did you mean?',
  person: { heard: 'Karim', status: 'ambiguous' },
  options: [karim('Karim Aziz', 'Runner'), karim('Karim Saleh', 'Bartender')],
};

const readings: ParsedIntent = {
  intent: 'UNRECOGNIZED',
  reason: 'It could be either of these.',
  summary: 'Which did you mean?',
  options: [
    { ...shift, summary: 'Create a Bartender shift for Alex Example on Friday, 18:00 to 02:00.', start: '18:00', end: '02:00' },
    { ...shift, summary: 'Create a Bartender shift for Alex Example on Friday, 06:00 to 14:00.', start: '06:00', end: '14:00' },
  ],
};

const notUnderstood: ParsedIntent = { intent: 'UNRECOGNIZED', reason: 'Say it again, or fix what I heard and try again.', summary: "I didn't catch what you'd like to do." };

const almost: ParsedIntent = {
  intent: 'UNRECOGNIZED',
  reason: 'Add the end time and the role, then run it again.',
  summary: "I've got a new shift for Alex Example on Friday 9 October 2026 from 18:00 — what time does it end, and which role?",
  incomplete: { intent: 'CREATE_SHIFT', missing: ['end', 'role'] },
};

const answer: ParsedIntent = {
  intent: 'WHO_IS_WORKING',
  confidence: 0.92,
  summary: 'Three people are working tonight.',
  answer: {
    title: 'Working tonight — Thursday 8 October 2026',
    items: [
      { primary: 'Alex Example', secondary: 'Bartender', tertiary: '18:00 – 02:00 (ends Friday)' },
      { primary: 'Sam Sample', secondary: 'Server', tertiary: '17:00 – 23:00' },
      { primary: 'Karim Aziz', secondary: 'Runner', tertiary: '18:00 – 00:00' },
    ],
    emptyText: 'Nobody is working tonight.',
  },
};

const declined: ParsedIntent = {
  intent: 'DECLINED',
  category: 'people_deactivate_delete',
  message: "Removing or deactivating someone isn't done by voice. Do it in People.",
  screen: { label: 'People', path: '/people' },
  summary: 'Not by voice.',
  confidence: 1,
};

const sheet = (intent: ParsedIntent, transcript: string, extra: Partial<SheetProps> = {}): SheetProps => ({
  intent,
  transcript,
  hasAdditionalRequest: false,
  executed: false,
  executing: false,
  reparsing: false,
  viewerName: PREVIEW_VIEWER,
  canManageStaff: true,
  origin: 'voice',
  examples: ["Who's working tonight?", 'Add an open bartender shift tomorrow 6pm to 2am', 'Any pending requests?'],
  problem: null,
  ...extra,
});

const withResult = (s: SheetProps, patch: Partial<VoiceStageState> = {}): PreviewState => ({
  state: { ...idle, result: { intent: s.intent!, executed: s.executed, hasAdditionalRequest: s.hasAdditionalRequest }, executing: s.executing, reparsing: s.reparsing, ...patch },
  heard: s.origin === 'voice' ? s.transcript : '',
  composerText: '',
  sheet: s,
});

const composer = (patch: Partial<VoiceStageState['composer']>, text = ''): PreviewState => ({
  state: { ...idle, composer: { open: true, problem: null, sending: false, ...patch } },
  heard: '',
  composerText: text,
});

export const PREVIEW_STATES: Record<string, () => PreviewState> = {
  starting: () => ({ state: { ...idle, starting: true }, heard: '', composerText: '' }),
  listening: () => ({ state: { ...idle, recording: true }, heard: '', composerText: '' }),
  transcribing: () => ({ state: { ...idle, phase: 'transcribing' }, heard: '', composerText: '' }),
  understanding: () => ({ state: { ...idle, phase: 'understanding' }, heard: SAID, composerText: '' }),
  typing: () => composer({}),
  'typing-sending': () => composer({ sending: true }, 'Who is on the terrace tonight?'),
  'problem-mic': () => composer({ problem: micProblem(new DOMException('no', 'NotAllowedError')) }),
  'problem-offline': () => composer({ problem: offlineProblem('record') }),
  'problem-timeout': () => composer({ problem: requestProblem(new VoiceTimeoutError(25), { stage: 'understand', online: true }) }, "Who's working tonight?"),
  'confirm-shoutout': () => withResult(sheet(shoutout, SAID)),
  'confirm-shift': () => withResult(sheet(shift, 'Add Alex on Friday from half six to one, bar')),
  'confirm-cancel': () => withResult(sheet(cancel, "Cancel Sam's Saturday shift")),
  'confirm-publish': () => withResult(sheet(publish, "Publish next week's rota")),
  'confirm-assign': () => withResult(sheet(assign, 'Put Sam on the terrace Friday evening')),
  'confirm-timeoff': () => withResult(sheet(timeOff, 'Book Monday to Wednesday off for a family visit', { origin: 'typed' })),
  'confirm-offline': () => withResult(sheet(shoutout, SAID, { problem: offlineProblem('execute') })),
  sending: () => withResult(sheet(shoutout, SAID, { executing: true })),
  'which-one': () => withResult(sheet(whichOne, 'Give Karim a shout-out saying well done')),
  'which-one-chosen': () => withResult(sheet(karim('Karim Aziz', 'Runner'), 'Give Karim a shout-out saying well done', { backToChoices: true })),
  readings: () => withResult(sheet(readings, 'Alex Friday six to two bar')),
  'not-understood': () => withResult(sheet(notUnderstood, 'umm the thing for later')),
  'almost-there': () => withResult(sheet(almost, 'New shift for Alex on Friday from six')),
  answer: () => withResult(sheet(answer, "Who's working tonight?")),
  declined: () => withResult(sheet(declined, 'Deactivate Sam Sample')),
  'done-follow-up': () => withResult(sheet(shoutout, SAID, { executed: true, hasAdditionalRequest: true })),
};
