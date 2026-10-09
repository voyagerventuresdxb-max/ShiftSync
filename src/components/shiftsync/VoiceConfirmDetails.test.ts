import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { ParsedIntent } from '@/api/voice';
import { VoiceCommandSheet } from './VoiceCommandSheet';

/**
 * Regression guard for the confirm sheet: whatever it looks like, every confirm variant keeps
 * saying WHO (full name), in WHICH ROLE, on WHICH DAY and DATE (weekday, day, month and year, all
 * spelled out) and at WHAT TIME, before the one big Confirm — including the reading picked from a
 * "Which one?" list. Made-up names.
 *
 * Where a field cannot exist it is named, not skipped silently: a shout-out has no day (it posts
 * "just now"), a publish is a whole week (no person, no clock time), a time-off request is the
 * caller's own, and the server sends no person role for swap and join decisions
 * (server/src/voice/parseIntent.ts `describeReading`).
 */

const noop = () => {};

function render(intent: ParsedIntent, chosenFromList = false): { text: string; buttons: string[] } {
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
        ...(chosenFromList ? { onBackToChoices: noop } : {}),
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

interface Day {
  weekday: string;
  day: string;
  month: string;
  year: string;
}

interface Expect {
  /** Full name: first and last. */
  name?: string;
  role?: string;
  day?: Day;
  /** Clock times as shown ("18:30 – 01:00 (ends Saturday)"), or the part of the day for a floor section. */
  time?: string;
  /** What the Confirm button says. */
  confirm: string;
  /** The fields the owner's list asks for that this variant cannot have, and why. */
  notApplicable?: string;
}

const fri9: Day = { weekday: 'Friday', day: '9', month: 'October', year: '2026' };
const sat10: Day = { weekday: 'Saturday', day: '10', month: 'October', year: '2026' };
const mon12: Day = { weekday: 'Monday', day: '12', month: 'October', year: '2026' };

const shoutout = (name: string, role: string): ParsedIntent => ({
  intent: 'POST_SHOUTOUT', targetUserId: name, targetUserName: name.split(' ')[0]!, content: 'Great job', confidence: 0.9, summary: `Give ${name} a shout-out.`, details: { person: name, personRole: role },
});
const shift = (name: string, role: string): ParsedIntent => ({
  intent: 'CREATE_SHIFT', roleId: 'r', date: '2026-10-09', start: '18:30', end: '01:00', userId: name, confidence: 0.9, summary: `Create a ${role} shift for ${name}.`, details: { person: name, personRole: role, role },
});
const section = (name: string, role: string): ParsedIntent => ({
  intent: 'ASSIGN_SECTION', sectionId: 's', staffId: name, shiftDate: '2026-10-09', period: 'PM', dutyLabel: null, confidence: 0.9, summary: `Put ${name} on the terrace.`, details: { person: name, personRole: role, section: 'Terrace' },
});

const CASES: Array<[string, ParsedIntent, Expect, boolean?]> = [
  // Shifts
  ['shift: new, for a person', shift('Alex Example', 'Bartender'), { name: 'Alex Example', role: 'Bartender', day: fri9, time: '18:30 – 01:00 (ends Saturday)', confirm: 'Confirm' }],
  [
    'shift: split, two parts',
    {
      intent: 'CREATE_SHIFT', roleId: 'r', date: '2026-10-09', start: '11:00', end: '15:00', second: { start: '18:00', end: '23:00' }, userId: 'u', confidence: 0.9, summary: 'Create a split shift.',
      details: { person: 'Alex Example', personRole: 'Server', role: 'Server' },
    },
    { name: 'Alex Example', role: 'Server', day: fri9, time: '11:00 – 15:00', confirm: 'Confirm' },
  ],
  [
    'shift: open (nobody named)',
    { intent: 'CREATE_SHIFT', roleId: 'r', date: '2026-10-10', start: '18:00', end: '02:00', userId: null, confidence: 0.9, summary: 'Create an open shift.', details: { person: null, role: 'Bartender' } },
    { name: 'Open shift', role: 'Bartender', day: sat10, time: '18:00 – 02:00 (ends Sunday)', confirm: 'Confirm', notApplicable: 'no person: an open shift' },
  ],
  [
    'shift: change',
    {
      intent: 'EDIT_SHIFT', shiftId: 's', start: '19:00', confidence: 0.9, summary: 'Move the shift.',
      details: { person: 'Sam Sample', personRole: 'Server', shift: { date: '2026-10-09', start: '18:00', end: '23:00', role: 'Server', person: 'Sam Sample' } },
    },
    { name: 'Sam Sample', role: 'Server', day: fri9, time: '19:00 – 23:00', confirm: 'Confirm' },
  ],
  [
    'shift: cancel',
    { intent: 'CANCEL_SHIFT', shiftId: 's', confidence: 0.9, summary: 'Cancel the shift.', details: { person: 'Sam Sample', personRole: 'Server', date: '2026-10-10', start: '12:00', end: '20:00', role: 'Server' } },
    { name: 'Sam Sample', role: 'Server', day: sat10, time: '12:00 – 20:00', confirm: 'Confirm: cancel this shift' },
  ],
  // Floor section
  ['section assignment', section('Sam Sample', 'Server'), { name: 'Sam Sample', role: 'Server', day: fri9, time: 'Evening (PM)', confirm: 'Confirm' }],
  // Shout-out
  ['shout-out', shoutout('Alex Example', 'Bartender'), { name: 'Alex Example', role: 'Bartender', time: 'just now', confirm: 'Confirm', notApplicable: 'no day or date: it posts now ("just now")' }],
  // Publish
  [
    'publish the week',
    { intent: 'PUBLISH_ROTA', weekStart: '2026-10-12', counts: { shiftsChanging: 12, peopleNotified: 8 }, confidence: 0.9, summary: 'Publish the week.' },
    { day: mon12, confirm: 'Confirm: publish and notify 8 people', notApplicable: 'no person or clock time: a whole week (the counts are checked below)' },
  ],
  // Swaps
  [
    'swap: request (staff asks a colleague)',
    {
      intent: 'REQUEST_SWAP', shiftId: 's', targetUserId: 'u', targetUserName: 'Alex', reason: null, confidence: 0.9, summary: 'Ask Alex Example to cover.',
      details: { person: 'Alex Example', personRole: 'Bartender', shift: { date: '2026-10-09', start: '18:00', end: '23:00' } },
    },
    { name: 'Alex Example', role: 'Bartender', day: fri9, time: '18:00 – 23:00', confirm: 'Confirm' },
  ],
  [
    'swap: approve',
    { intent: 'APPROVE_SWAP', swapRequestId: 'q', confidence: 0.9, summary: "Approve Sam Sample's swap request.", details: { person: 'Sam Sample', cover: 'Alex Example', shift: { date: '2026-10-09', start: '18:00', end: '23:00' } } },
    { name: 'Sam Sample', day: fri9, time: '18:00 – 23:00', confirm: 'Confirm', notApplicable: 'role: the server sends none for swap decisions' },
  ],
  [
    'swap: decline',
    { intent: 'DECLINE_SWAP', swapRequestId: 'q', confidence: 0.9, summary: "Decline Sam Sample's swap request.", details: { person: 'Sam Sample', cover: null, shift: { date: '2026-10-09', start: '18:00', end: '23:00' } } },
    { name: 'Sam Sample', day: fri9, time: '18:00 – 23:00', confirm: 'Confirm', notApplicable: 'role: the server sends none for swap decisions' },
  ],
  // The reading picked from a "Which one?" list: the same sheet, with "Other choices" to go back.
  ['Which-one result: a shift for the chosen person', shift('Karim Saleh', 'Bartender'), { name: 'Karim Saleh', role: 'Bartender', day: fri9, time: '18:30 – 01:00 (ends Saturday)', confirm: 'Confirm' }, true],
  ['Which-one result: a section for the chosen person', section('Karim Aziz', 'Runner'), { name: 'Karim Aziz', role: 'Runner', day: fri9, time: 'Evening (PM)', confirm: 'Confirm' }, true],
  ['Which-one result: a shout-out for the chosen person', shoutout('Karim Saleh', 'Bartender'), { name: 'Karim Saleh', role: 'Bartender', time: 'just now', confirm: 'Confirm', notApplicable: 'no day or date: it posts now' }, true],
  // The rest of the confirmable commands.
  ['join request', { intent: 'APPROVE_JOIN', joinRequestId: 'j', confidence: 0.9, summary: "Approve Riley Demo's request to join.", details: { person: 'Riley Demo' } }, { name: 'Riley Demo', confirm: 'Confirm', notApplicable: 'role, day and time: a join request has none' }],
  ['availability', { intent: 'MARK_AVAILABILITY', date: '2026-10-16', type: 'UNAVAILABLE', confidence: 0.9, summary: 'Mark you unavailable.' }, { day: { weekday: 'Friday', day: '16', month: 'October', year: '2026' }, confirm: 'Confirm', notApplicable: 'the caller\'s own, a whole day' }],
  ['time off', { intent: 'REQUEST_TIME_OFF', startDate: '2026-10-12', endDate: '2026-10-14', reason: null, confidence: 0.9, summary: 'Request time off.' }, { day: mon12, confirm: 'Confirm', notApplicable: 'the caller\'s own, whole days' }],
  ['rota template', { intent: 'APPLY_ROTA_TEMPLATE', templateId: 't', templateName: 'Weekend Standard', weekStart: '2026-10-12', confidence: 0.9, summary: 'Apply the template.' }, { day: mon12, confirm: 'Confirm', notApplicable: 'a whole week of drafts' }],
];

const ABBREVIATED = /\b(Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b\.?/;

for (const [label, intent, expected, chosenFromList] of CASES) {
  test(`confirm sheet keeps name, role, day, date and time: ${label}`, () => {
    const { text, buttons } = render(intent, chosenFromList);
    if (expected.name) {
      assert.ok(text.includes(expected.name), `name "${expected.name}" in: ${text}`);
      if (expected.name !== 'Open shift') assert.match(expected.name, /^\S+ \S+/, 'a full name, first and last');
    }
    if (expected.role) assert.ok(text.includes(expected.role), `role "${expected.role}" in: ${text}`);
    if (expected.day) {
      const { weekday, day, month, year } = expected.day;
      // Each part on its own, and together as one spelled-out date.
      for (const part of [weekday, month, year]) assert.ok(text.includes(part), `"${part}" in: ${text}`);
      assert.ok(text.includes(`${weekday} ${day} ${month} ${year}`), `"${weekday} ${day} ${month} ${year}" in: ${text}`);
    }
    if (expected.time) assert.ok(text.includes(expected.time), `time "${expected.time}" in: ${text}`);
    // Days and months are never abbreviated ("Fri", "Oct").
    assert.doesNotMatch(text, ABBREVIATED, text);
    // What was heard is on every sheet; Confirm is the one big action, before Edit and Cancel/Keep.
    assert.ok(text.includes('“what was said”'), text);
    const actions = chosenFromList ? (assert.equal(buttons[0], 'Other choices'), buttons.slice(1)) : buttons;
    assert.equal(actions[0], expected.confirm);
    assert.equal(actions[1], 'Edit');
    assert.match(actions[2]!, /^(Cancel|Keep shift)$/);
    assert.equal(actions.length, 3);
  });
}

test('the publish card states both counts in a sentence as well as in the button', () => {
  const { text } = render({ intent: 'PUBLISH_ROTA', weekStart: '2026-10-12', counts: { shiftsChanging: 12, peopleNotified: 8 }, confidence: 0.9, summary: 'Publish.' });
  assert.ok(text.includes('12 shifts will change and 8 people will be notified.'), text);
  assert.match(text, /Shifts changing 12/);
  assert.match(text, /People notified 8/);
});

test('which one: every candidate is a tappable card with their full name and role, and no Confirm before one is chosen', () => {
  const { buttons } = render({
    intent: 'UNRECOGNIZED', reason: 'x', summary: 'Which Karim did you mean?', person: { heard: 'Karim', status: 'ambiguous' },
    options: [shift('Karim Aziz', 'Runner'), shift('Karim Saleh', 'Bartender')],
  });
  assert.ok(buttons.some((b) => b.includes('Karim Aziz') && b.includes('Runner')), buttons.join(' | '));
  assert.ok(buttons.some((b) => b.includes('Karim Saleh') && b.includes('Bartender')), buttons.join(' | '));
  assert.ok(!buttons.some((b) => /^Confirm/.test(b)), 'no Confirm before a person is chosen');
});
