import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfOnlyNamesOther, weekdayMismatch } from './parseIntent.js';
import { namedForSomeone } from './people.js';
import { buildSystemPrompt, calendarDay } from './prompts.js';
import type { ParsedIntent } from './intentSchema.js';

const shift = (date: string): ParsedIntent => ({ intent: 'CREATE_SHIFT', roleId: 'r', date, start: '18:00', end: '02:00', userId: 'u', confidence: 0.9, summary: 's' });

test('weekdayMismatch: "Friday" resolved to a Saturday is asked again, with both days named', () => {
  // 2031-03-07 is a Friday, 2031-03-08 a Saturday.
  const r = weekdayMismatch('Create a bartender shift for Alex on Friday from 6 to 2', shift('2031-03-08'));
  assert.ok(r && r.intent === 'UNRECOGNIZED');
  assert.match(r.summary, /You said Friday, but that date is a Saturday/);
  assert.equal(weekdayMismatch('Create a bartender shift for Alex on Friday from 6 to 2', shift('2031-03-07')), null);
});

test('weekdayMismatch: no weekday, two weekdays, or no date in the intent → no opinion', () => {
  assert.equal(weekdayMismatch('a shift tomorrow from 6 to 2', shift('2031-03-08')), null);
  assert.equal(weekdayMismatch("move Alex's Friday shift to Saturday", shift('2031-03-08')), null);
  assert.equal(weekdayMismatch('publish Friday', { intent: 'PUBLISH_ROTA', weekStart: '2031-03-03', confidence: 0.9, summary: 's' }), null);
  assert.equal(
    weekdayMismatch('put Alex on the bar Friday', { intent: 'ASSIGN_SECTION', sectionId: 's', staffId: 'u', shiftDate: '2031-03-08', period: 'PM', dutyLabel: null, confidence: 0.9, summary: 's' })?.intent,
    'UNRECOGNIZED',
  );
});

test('the prompt carries a 14-day calendar with weekday names, starting today', () => {
  assert.equal(calendarDay('2031-03-03', 0), 'Monday 2031-03-03');
  assert.equal(calendarDay('2031-03-03', 4), 'Friday 2031-03-07');
  const prompt = buildSystemPrompt('STAFF', { today: '2031-03-03', hint: '' });
  assert.match(prompt, /Today is Monday 2031-03-03\./);
  assert.match(prompt, /Calendar .*Monday 2031-03-03; Tuesday 2031-03-04; .*Sunday 2031-03-16\. Weeks start on Monday\./);
});

const team = [
  { id: 'me', fullName: 'Hannah Clarke' },
  { id: 'omar', fullName: 'Omar Haddad' },
  { id: 'alex', fullName: 'Alex Morgan' },
];
const timeOff: ParsedIntent = { intent: 'REQUEST_TIME_OFF', startDate: '2031-03-07', endDate: '2031-03-07', reason: null, confidence: 0.95, summary: 'Ask for Fri 7 Mar off.' };
const unavailable: ParsedIntent = { intent: 'MARK_AVAILABILITY', date: '2031-03-07', type: 'UNAVAILABLE', confidence: 0.95, summary: 's' };

test('time off or availability that names someone else is asked, never offered: it would book the caller instead', () => {
  const r = selfOnlyNamesOther(timeOff, 'Give Omar next Friday off.', team, 'me');
  assert.ok(r && r.intent === 'UNRECOGNIZED');
  assert.equal(r.summary, "That would book your own days off, not Omar's.");
  assert.match(r.reason ?? '', /use the rota/);
  assert.equal(selfOnlyNamesOther(unavailable, 'Mark Alex Morgan unavailable on Friday', team, 'me')?.intent, 'UNRECOGNIZED');
});

test('time off and availability for yourself are untouched, even when you say your own name; other readings are not this check', () => {
  assert.equal(selfOnlyNamesOther(timeOff, 'I need next Friday off.', team, 'me'), null);
  assert.equal(selfOnlyNamesOther(timeOff, 'This is Hannah, I need Friday off.', team, 'me'), null);
  assert.equal(selfOnlyNamesOther(unavailable, 'Mark me unavailable on Friday', team, 'me'), null);
  assert.equal(selfOnlyNamesOther({ intent: 'POST_SHOUTOUT', targetUserId: 'omar', targetUserName: 'Omar', content: 'x', confidence: 0.9, summary: 's' }, 'Give Omar a shout-out', team, 'me'), null);
});

test('F8: a name nobody on the team has, in time off or availability, is asked about, never booked as the caller\'s own', () => {
  const r = selfOnlyNamesOther(timeOff, 'Give Zebulon next Friday off.', team, 'me');
  assert.ok(r && r.intent === 'UNRECOGNIZED');
  assert.equal(r.summary, "I couldn't find Zebulon on your team.");
  assert.match(r.reason ?? '', /^Who did you mean\?/);
  assert.deepEqual(r.person, { heard: 'Zebulon', status: 'missing' });
  for (const said of ['Zebulon needs next Friday off', 'Time off for Zebulon next Friday', "Book Zebulon's day off on Friday"]) {
    assert.equal(selfOnlyNamesOther(timeOff, said, team, 'me')?.summary, "I couldn't find Zebulon on your team.", said);
  }
  assert.equal(selfOnlyNamesOther(unavailable, 'Mark Zebulon unavailable on Friday', team, 'me')?.summary, "I couldn't find Zebulon on your team.");
});

test('F8: a close name is offered to read again ("Alix" → Alex Morgan)', () => {
  const r = selfOnlyNamesOther(timeOff, 'Give Alix next Friday off.', team, 'me');
  assert.ok(r && r.intent === 'UNRECOGNIZED');
  assert.equal(r.summary, "I couldn't find Alix on your team.");
  assert.match(r.reason ?? '', /^Did you mean Alex Morgan\?/);
  assert.deepEqual(r.retry, [{ person: 'Alex Morgan', text: 'Give Alex Morgan next Friday off.' }]);
});

test('F8: the words that only sit where a name would are not names; the venue\'s own words are not either', () => {
  for (const said of ['Give me next Friday off', 'Book next Friday off', 'Mark Friday as unavailable', 'I need Friday off', "I'm off on Friday", 'Give myself the day off', 'Put in for Eid off', 'Give her next Friday off']) {
    assert.deepEqual(namedForSomeone(said), [], said);
  }
  assert.deepEqual(namedForSomeone('Create a Bartender shift on Friday for Zebulon', ['Bartender']), ['Zebulon']);
  assert.deepEqual(namedForSomeone('Schedule Bartender Friday 6 to 2', ['Bartender']), []);
  assert.deepEqual(namedForSomeone('Create a shift for Terrace on Friday', ['Terrace']), []);
  assert.deepEqual(namedForSomeone('time off for zebulon on friday'), ['zebulon']);
});
