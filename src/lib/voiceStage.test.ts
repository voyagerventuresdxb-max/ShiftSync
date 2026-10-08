import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedIntent } from '@/api/voice';
import { micProblem, NOTHING_HEARD, offlineProblem, requestProblem, UNSUPPORTED } from './voiceErrors';
import { VoiceTimeoutError } from '@/api/voice';
import { orbLook } from './voiceOrb';
import {
  voiceCloseAction,
  voiceContextLine,
  voiceMicControl,
  voiceOrbPhase,
  voiceResultKind,
  voiceStageAnnouncement,
  voiceStageMode,
  voiceStagePosition,
  voiceStageWord,
  type VoiceStageState,
} from './voiceStage';

/** AppShell's voice state at rest: nothing open. */
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
const at = (patch: Partial<VoiceStageState>): VoiceStageState => ({ ...idle, ...patch });
const result = (intent: ParsedIntent, executed = false) => ({ intent, executed, hasAdditionalRequest: false });

const shoutout: ParsedIntent = { intent: 'POST_SHOUTOUT', targetUserId: 'u', targetUserName: 'Alex Example', content: 'Great job', confidence: 0.95, summary: 'Give Alex Example a shout-out.' };
const notUnderstood: ParsedIntent = { intent: 'UNRECOGNIZED', reason: 'Say it again.', summary: "I didn't catch what you'd like to do." };
const whichOne: ParsedIntent = { intent: 'UNRECOGNIZED', reason: 'x', summary: 'Which Karim did you mean?', person: { heard: 'Karim', status: 'ambiguous' }, options: [shoutout, shoutout] };
const answer: ParsedIntent = { intent: 'WHO_IS_WORKING', confidence: 0.9, summary: 'x', answer: { title: 'Working tonight', items: [], emptyText: 'Nobody.' } };
const declined: ParsedIntent = { intent: 'DECLINED', category: 'payroll_wps', message: 'Not by voice.', screen: null, summary: 'x', confidence: 1 };

/** One row per step: mode, orb shape, the one word, what a screen reader hears, close and mic. */
function snapshot(s: VoiceStageState) {
  const mode = voiceStageMode(s);
  return { mode, orb: voiceOrbPhase(s), word: voiceStageWord(s), says: voiceStageAnnouncement(s), close: voiceCloseAction(mode), mic: voiceMicControl(mode).action };
}

/** Walks a sequence of AppShell states and returns each step's snapshot (the transitions). */
const walk = (...states: VoiceStageState[]) => states.map(snapshot);

test('spoken command, start to finish: ready → listening → transcribing → understanding → ready to confirm → sending → closed', () => {
  assert.deepEqual(
    walk(
      idle,
      at({ starting: true }),
      at({ recording: true }),
      at({ phase: 'transcribing' }),
      at({ phase: 'understanding' }),
      at({ result: result(shoutout) }),
      at({ result: result(shoutout), executing: true }),
      idle,
    ),
    [
      { mode: 'closed', orb: 'ready', word: '', says: '', close: 'none', mic: 'start' },
      { mode: 'starting', orb: 'ready', word: 'Starting', says: 'Starting the microphone…', close: 'none', mic: 'none' },
      { mode: 'listening', orb: 'listening', word: 'Listening', says: 'Listening… tap the mic to stop', close: 'discard-recording', mic: 'stop' },
      { mode: 'transcribing', orb: 'transcribing', word: 'Transcribing', says: 'Transcribing…', close: 'hide-until-answer', mic: 'none' },
      { mode: 'understanding', orb: 'understanding', word: 'Understanding', says: 'Understanding…', close: 'hide-until-answer', mic: 'none' },
      // The confirm sheet speaks for itself from here ("Ready to confirm", "Doing it…").
      { mode: 'result', orb: 'confirm', word: 'Ready', says: '', close: 'none', mic: 'start' },
      { mode: 'result', orb: 'sending', word: 'Sending', says: '', close: 'none', mic: 'start' },
      { mode: 'closed', orb: 'ready', word: '', says: '', close: 'none', mic: 'start' },
    ],
  );
});

test('typed command: keyboard → understanding → confirm; typed words never pass through listening', () => {
  const steps = walk(
    at({ composer: { open: true, problem: null, sending: false } }),
    at({ composer: { open: true, problem: null, sending: true } }),
    at({ result: result(shoutout) }),
  );
  assert.deepEqual(
    steps.map((s) => [s.mode, s.orb, s.word, s.says, s.close]),
    [
      ['typing', 'ready', 'Ready', '', 'close'],
      ['sending-typed', 'understanding', 'Understanding', 'Understanding…', 'none'],
      ['result', 'confirm', 'Ready', '', 'none'],
    ],
  );
  // The step marks count from Understanding for a typed command.
  assert.deepEqual(voiceStagePosition(at({ composer: { open: true, problem: null, sending: true } }), 'typed'), { index: 1, total: 4 });
  assert.deepEqual(voiceStagePosition(at({ phase: 'understanding' }), 'voice'), { index: 3, total: 6 });
});

test('every problem is a still, dim orb with the typed box: microphone off, missing, unsupported, offline, silence, timeout, limit, unavailable', () => {
  const problems = [
    micProblem(new DOMException('no', 'NotAllowedError')),
    micProblem(new DOMException('no', 'NotFoundError')),
    micProblem(new Error('busy')),
    UNSUPPORTED,
    offlineProblem('record'),
    offlineProblem('understand'),
    NOTHING_HEARD,
    requestProblem(new VoiceTimeoutError(25), { stage: 'understand', online: true }),
  ];
  for (const problem of problems) {
    const s = at({ composer: { open: true, problem, sending: false } });
    assert.deepEqual(snapshot(s), { mode: 'problem', orb: 'problem', word: '', says: '', close: 'close', mic: 'start' }, problem.kind);
    const look = orbLook(voiceOrbPhase(s), false);
    assert.equal(look.animate, false, problem.kind);
    assert.ok(look.alpha < 0.5, problem.kind);
  }
});

test('error transitions: permission denied, offline at the tap, silence, transcribe timeout, parse offline — each lands on the problem', () => {
  const denied = micProblem(new DOMException('no', 'NotAllowedError'));
  const p = (problem = denied) => at({ composer: { open: true, problem, sending: false } });
  // starting → denied
  assert.deepEqual(walk(at({ starting: true }), p()).map((s) => s.mode), ['starting', 'problem']);
  // offline before anything is recorded: straight to the problem, never listening
  assert.deepEqual(walk(idle, p(offlineProblem('record'))).map((s) => s.mode), ['closed', 'problem']);
  // a silent clip is never sent
  assert.deepEqual(walk(at({ recording: true }), p(NOTHING_HEARD)).map((s) => s.mode), ['listening', 'problem']);
  // transcribe timed out / parse offline: the words so far stay in the box (AppShell), the orb stops
  assert.deepEqual(
    walk(at({ phase: 'transcribing' }), p(requestProblem(new VoiceTimeoutError(25), { stage: 'understand', online: true }))).map((s) => [s.mode, s.orb]),
    [['transcribing', 'transcribing'], ['problem', 'problem']],
  );
  assert.deepEqual(walk(at({ phase: 'understanding' }), p(offlineProblem('understand'))).map((s) => [s.mode, s.orb]), [['understanding', 'understanding'], ['problem', 'problem']]);
  // typed while offline: sending → problem (nothing was sent)
  assert.deepEqual(
    walk(at({ composer: { open: true, problem: null, sending: true } }), p(offlineProblem('understand'))).map((s) => s.mode),
    ['sending-typed', 'problem'],
  );
  // from a problem, the mic starts again (the box gives way to the recording)
  assert.deepEqual(walk(p(), at({ starting: true }), at({ recording: true })).map((s) => s.mode), ['problem', 'starting', 'listening']);
});

test('a Confirm that went offline or timed out stays on the confirm sheet (the sheet shows why); Confirm again sends', () => {
  const steps = walk(at({ result: result(shoutout), executing: true }), at({ result: result(shoutout) }), at({ result: result(shoutout), executing: true }));
  assert.deepEqual(steps.map((s) => [s.mode, s.orb]), [['result', 'sending'], ['result', 'confirm'], ['result', 'sending']]);
});

test('result kinds: confirm, answer, which-one, not understood, declined, done after Confirm', () => {
  assert.equal(voiceResultKind(shoutout, false), 'confirm');
  assert.equal(voiceResultKind(shoutout, true), 'done');
  assert.equal(voiceResultKind(answer, false), 'answer');
  assert.equal(voiceResultKind({ intent: 'QUERY_MY_SCHEDULE', confidence: 0.9, summary: 'x' }, false), 'answer');
  assert.equal(voiceResultKind(whichOne, false), 'choose');
  assert.equal(voiceResultKind({ ...notUnderstood, team: [shoutout] }, false), 'choose');
  assert.equal(voiceResultKind({ ...notUnderstood, retry: [{ person: 'Alex Example', text: 'x' }] }, false), 'choose');
  assert.equal(voiceResultKind(notUnderstood, false), 'unclear');
  assert.equal(voiceResultKind({ ...notUnderstood, incomplete: { intent: 'CREATE_SHIFT', missing: ['end'] } }, false), 'unclear');
  assert.equal(voiceResultKind(declined, false), 'declined');

  const orb = (intent: ParsedIntent, extra: Partial<VoiceStageState> = {}) => voiceOrbPhase(at({ result: result(intent), ...extra }));
  assert.equal(orb(shoutout), 'confirm');
  assert.equal(orb(answer), 'confirm');
  assert.equal(orb(whichOne), 'choose');
  assert.equal(orb(notUnderstood), 'unclear');
  assert.equal(orb(declined), 'unclear');
  // "Update preview" with edited words: the sheet stays up while the words are read again.
  assert.equal(orb(notUnderstood, { reparsing: true }), 'rereading');
  assert.equal(voiceStageWord(at({ result: result(notUnderstood), reparsing: true })), 'Understanding');
  // Which-one is small and dim; not understood is small, dim and still.
  assert.ok(orbLook('choose', false).alpha < 1 && orbLook('choose', false).scale < 0.5);
  assert.equal(orbLook('unclear', false).animate, false);
});

test('closing: while recording it discards, while reading it hides until the answer, with nothing to close it does nothing', () => {
  // Close while listening → the recorder stops unsent (AppShell) → closed.
  assert.deepEqual(walk(at({ recording: true }), idle).map((s) => [s.mode, s.close]), [['listening', 'discard-recording'], ['closed', 'none']]);
  // Close while understanding → hidden; the answer brings the sheet back.
  assert.deepEqual(
    walk(at({ phase: 'understanding' }), at({ phase: 'understanding', hiddenWhileBusy: true }), at({ result: result(shoutout) })).map((s) => s.mode),
    ['understanding', 'closed', 'result'],
  );
  // A problem after hiding comes back too (AppShell clears the flag when the round trip ends).
  assert.equal(voiceStageMode(at({ composer: { open: true, problem: NOTHING_HEARD, sending: false } })), 'problem');
  // The permission prompt and a typed command in flight can't be closed from the sheet.
  assert.equal(voiceCloseAction('starting'), 'none');
  assert.equal(voiceCloseAction('sending-typed'), 'none');
  assert.equal(voiceCloseAction('typing'), 'close');
});

test('the mic button says what it does, with the dock mic\'s own words', () => {
  assert.deepEqual(voiceMicControl('typing'), { action: 'start', label: 'Start recording a voice command' });
  assert.deepEqual(voiceMicControl('problem'), { action: 'start', label: 'Start recording a voice command' });
  assert.deepEqual(voiceMicControl('listening'), { action: 'stop', label: 'Stop recording voice command' });
  assert.deepEqual(voiceMicControl('starting'), { action: 'none', label: 'Waiting for microphone permission' });
  for (const m of ['transcribing', 'understanding', 'sending-typed'] as const) assert.deepEqual(voiceMicControl(m), { action: 'none', label: 'Processing voice command' });
});

test('precedence: a result is shown over anything else; recording over the typed box', () => {
  assert.equal(voiceStageMode(at({ result: result(shoutout), composer: { open: true, problem: null, sending: false } })), 'result');
  assert.equal(voiceStageMode(at({ recording: true, composer: { open: true, problem: null, sending: false } })), 'listening');
  assert.equal(voiceStageMode(at({ starting: true, phase: 'understanding' })), 'starting');
});

test('the context line: venue and role, either alone when the other is missing', () => {
  assert.equal(voiceContextLine('The Example Room', 'MANAGER'), 'The Example Room · Manager');
  assert.equal(voiceContextLine(null, 'STAFF'), 'Staff');
  assert.equal(voiceContextLine('  The Example Room ', undefined), 'The Example Room');
  assert.equal(voiceContextLine(null, null), '');
});
