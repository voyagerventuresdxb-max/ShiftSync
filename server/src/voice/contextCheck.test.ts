import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekdayMismatch } from './parseIntent.js';
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
