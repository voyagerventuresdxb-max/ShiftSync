import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { ParsedIntent } from '@/api/voice';
import { VoiceCommandSheet } from './VoiceCommandSheet';

/**
 * Regression guard for the confirm sheet: whatever it looks like, every confirm variant keeps
 * saying WHO (full name), in WHICH ROLE, on WHICH DATE (weekday, day, month, year) and at WHAT
 * TIME — wherever the server sends them — before the one big Confirm. Made-up names.
 *
 * The server sends no person role for swap and join decisions (server/src/voice/parseIntent.ts
 * `describeReading`), so those rows check the name, date and time only.
 */

const noop = () => {};

function words(intent: ParsedIntent): { text: string; buttons: string[] } {
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(VoiceCommandSheet, {
        intent,
        transcript: 'what was said',
        hasAdditionalRequest: false,
        executed: false,
        onConfirm: noop,
        onChoose: noop,
        onReparse: noop,
        onCancel: noop,
        executing: false,
        reparsing: false,
        viewerName: 'Jordan Demo',
        canManageStaff: true,
      }),
    ),
  );
  const plain = (h: string) =>
    h
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  return { text: plain(html), buttons: [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => plain(m[1]!)) };
}

interface Expect {
  name?: string;
  role?: string;
  /** "Friday 9 October 2026": weekday, day, month and year. */
  date?: string;
  time?: string;
  confirm: string;
}

const CASES: Array<[string, ParsedIntent, Expect]> = [
  [
    'new shift for a person',
    { intent: 'CREATE_SHIFT', roleId: 'r', date: '2026-10-09', start: '18:30', end: '01:00', userId: 'u', confidence: 0.9, summary: 'Create a shift.', details: { person: 'Alex Example', personRole: 'Bartender', role: 'Bartender' } },
    { name: 'Alex Example', role: 'Bartender', date: 'Friday 9 October 2026', time: '18:30 – 01:00 (ends Saturday)', confirm: 'Confirm' },
  ],
  [
    'split shift',
    {
      intent: 'CREATE_SHIFT', roleId: 'r', date: '2026-10-09', start: '11:00', end: '15:00', second: { start: '18:00', end: '23:00' }, userId: 'u', confidence: 0.9, summary: 'Create a split shift.',
      details: { person: 'Alex Example', personRole: 'Server', role: 'Server' },
    },
    { name: 'Alex Example', role: 'Server', date: 'Friday 9 October 2026', time: '18:00 – 23:00', confirm: 'Confirm' },
  ],
  [
    'open shift (nobody named)',
    { intent: 'CREATE_SHIFT', roleId: 'r', date: '2026-10-10', start: '18:00', end: '02:00', userId: null, confidence: 0.9, summary: 'Create an open shift.', details: { person: null, role: 'Bartender' } },
    { name: 'Open shift', role: 'Bartender', date: 'Saturday 10 October 2026', time: '18:00 – 02:00 (ends Sunday)', confirm: 'Confirm' },
  ],
  [
    'shift change',
    {
      intent: 'EDIT_SHIFT', shiftId: 's', start: '19:00', confidence: 0.9, summary: 'Move the shift.',
      details: { person: 'Sam Sample', personRole: 'Server', shift: { date: '2026-10-09', start: '18:00', end: '23:00', role: 'Server', person: 'Sam Sample' } },
    },
    { name: 'Sam Sample', role: 'Server', date: 'Friday 9 October 2026', time: '19:00 – 23:00', confirm: 'Confirm' },
  ],
  [
    'cancel shift',
    { intent: 'CANCEL_SHIFT', shiftId: 's', confidence: 0.9, summary: 'Cancel the shift.', details: { person: 'Sam Sample', personRole: 'Server', date: '2026-10-10', start: '12:00', end: '20:00', role: 'Server' } },
    { name: 'Sam Sample', role: 'Server', date: 'Saturday 10 October 2026', time: '12:00 – 20:00', confirm: 'Confirm: cancel this shift' },
  ],
  [
    'floor section',
    { intent: 'ASSIGN_SECTION', sectionId: 'x', staffId: 'u', shiftDate: '2026-10-09', period: 'PM', dutyLabel: null, confidence: 0.9, summary: 'Put Sam on the terrace.', details: { person: 'Sam Sample', personRole: 'Server', section: 'Terrace' } },
    { name: 'Sam Sample', role: 'Server', date: 'Friday 9 October 2026', time: 'Evening (PM)', confirm: 'Confirm' },
  ],
  [
    'shout-out',
    { intent: 'POST_SHOUTOUT', targetUserId: 'u', targetUserName: 'Alex', content: 'Great job', confidence: 0.9, summary: 'Give Alex Example a shout-out.', details: { person: 'Alex Example', personRole: 'Bartender' } },
    { name: 'Alex Example', role: 'Bartender', confirm: 'Confirm' },
  ],
  [
    'swap request (staff asks a colleague)',
    {
      intent: 'REQUEST_SWAP', shiftId: 's', targetUserId: 'u', targetUserName: 'Alex', reason: null, confidence: 0.9, summary: 'Ask Alex Example to cover.',
      details: { person: 'Alex Example', personRole: 'Bartender', shift: { date: '2026-10-09', start: '18:00', end: '23:00' } },
    },
    { name: 'Alex Example', role: 'Bartender', date: 'Friday 9 October 2026', time: '18:00 – 23:00', confirm: 'Confirm' },
  ],
  [
    'approve a swap',
    { intent: 'APPROVE_SWAP', swapRequestId: 'q', confidence: 0.9, summary: "Approve Sam Sample's swap request.", details: { person: 'Sam Sample', cover: 'Alex Example', shift: { date: '2026-10-09', start: '18:00', end: '23:00' } } },
    { name: 'Sam Sample', date: 'Friday 9 October 2026', time: '18:00 – 23:00', confirm: 'Confirm' },
  ],
  [
    'decline a swap',
    { intent: 'DECLINE_SWAP', swapRequestId: 'q', confidence: 0.9, summary: "Decline Sam Sample's swap request.", details: { person: 'Sam Sample', cover: null, shift: { date: '2026-10-09', start: '18:00', end: '23:00' } } },
    { name: 'Sam Sample', date: 'Friday 9 October 2026', time: '18:00 – 23:00', confirm: 'Confirm' },
  ],
  ['approve a join request', { intent: 'APPROVE_JOIN', joinRequestId: 'j', confidence: 0.9, summary: "Approve Riley Demo's request to join.", details: { person: 'Riley Demo' } }, { name: 'Riley Demo', confirm: 'Confirm' }],
  ['mark unavailable', { intent: 'MARK_AVAILABILITY', date: '2026-10-16', type: 'UNAVAILABLE', confidence: 0.9, summary: 'Mark you unavailable.' }, { date: 'Friday 16 October 2026', confirm: 'Confirm' }],
  [
    'time off',
    { intent: 'REQUEST_TIME_OFF', startDate: '2026-10-12', endDate: '2026-10-14', reason: null, confidence: 0.9, summary: 'Request time off.' },
    { date: 'Monday 12 October 2026', confirm: 'Confirm' },
  ],
  [
    'publish the week',
    { intent: 'PUBLISH_ROTA', weekStart: '2026-10-12', counts: { shiftsChanging: 12, peopleNotified: 8 }, confidence: 0.9, summary: 'Publish the week.' },
    { date: 'Monday 12 October 2026', confirm: 'Confirm: publish and notify 8 people' },
  ],
  [
    'apply a template',
    { intent: 'APPLY_ROTA_TEMPLATE', templateId: 't', templateName: 'Weekend Standard', weekStart: '2026-10-12', confidence: 0.9, summary: 'Apply the template.' },
    { date: 'Monday 12 October 2026', confirm: 'Confirm' },
  ],
];

for (const [label, intent, expected] of CASES) {
  test(`confirm sheet keeps name, role, date and time: ${label}`, () => {
    const { text, buttons } = words(intent);
    if (expected.name) assert.ok(text.includes(expected.name), `name "${expected.name}" in: ${text}`);
    if (expected.role) assert.ok(text.includes(expected.role), `role "${expected.role}" in: ${text}`);
    if (expected.date) assert.ok(text.includes(expected.date), `date "${expected.date}" in: ${text}`);
    if (expected.time) assert.ok(text.includes(expected.time), `time "${expected.time}" in: ${text}`);
    // What was heard is on every sheet, and the one big Confirm comes first, before Edit and Cancel/Keep.
    assert.ok(text.includes('“what was said”'), text);
    assert.equal(buttons[0], expected.confirm);
    assert.equal(buttons[1], 'Edit');
    assert.match(buttons[2]!, /^(Cancel|Keep shift)$/);
  });
}

test('the publish card states both counts in a sentence as well as in the button', () => {
  const { text } = words({ intent: 'PUBLISH_ROTA', weekStart: '2026-10-12', counts: { shiftsChanging: 12, peopleNotified: 8 }, confidence: 0.9, summary: 'Publish.' });
  assert.ok(text.includes('12 shifts will change and 8 people will be notified.'), text);
  assert.match(text, /Shifts changing 12/);
  assert.match(text, /People notified 8/);
});

test('which one: every candidate is a tappable card with their full name and role', () => {
  const karim = (name: string, role: string): ParsedIntent => ({
    intent: 'POST_SHOUTOUT', targetUserId: name, targetUserName: name, content: 'Well done', confidence: 0.9, summary: `Give ${name} a shout-out.`, details: { person: name, personRole: role },
  });
  const { buttons } = words({
    intent: 'UNRECOGNIZED', reason: 'x', summary: 'Which Karim did you mean?', person: { heard: 'Karim', status: 'ambiguous' },
    options: [karim('Karim Aziz', 'Runner'), karim('Karim Saleh', 'Bartender')],
  });
  assert.ok(buttons.some((b) => b.includes('Karim Aziz') && b.includes('Runner')), buttons.join(' | '));
  assert.ok(buttons.some((b) => b.includes('Karim Saleh') && b.includes('Bartender')), buttons.join(' | '));
  assert.ok(!buttons.some((b) => /^Confirm/.test(b)), 'no Confirm before a person is chosen');
});
