import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ParsedIntent } from '@/api/voice';
import { VoicePreview } from './VoicePreview';

/** The preview as plain text, one space between elements, so assertions read like the screen. */
function render(intent: ParsedIntent): string {
  const html = renderToStaticMarkup(createElement(VoicePreview, { intent, viewerName: 'Sam Sample' }));
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

test('CANCEL_SHIFT: the person, their role, the full day and times, and plainly a cancellation', () => {
  const text = render({
    intent: 'CANCEL_SHIFT',
    shiftId: 'shift-1',
    confidence: 0.95,
    summary: "Cancel Alex Example's Friday shift.",
    details: { person: 'Alex Example', personRole: 'Bartender', date: '2026-10-09', start: '18:30', end: '01:00', role: 'Bartender' },
  });
  assert.match(text, /^Shift to cancel/);
  assert.match(text, /Alex Example/);
  assert.match(text, /Cancel/);
  assert.match(text, /Bartender · Friday 9 October 2026, 18:30 – 01:00 \(ends Saturday\)/);
  assert.match(text, /This shift comes off the rota, and Alex Example is no longer working it\./);
});

test('CANCEL_SHIFT without its details draws nothing rather than guess', () => {
  const intent = { intent: 'CANCEL_SHIFT', shiftId: 's', confidence: 0.9, summary: 'Cancel.' } as unknown as ParsedIntent;
  assert.equal(render(intent), '');
});

test('REQUEST_TIME_OFF: whose time off it is (yours), both dates in full, the number of days, and the reason', () => {
  const text = render({ intent: 'REQUEST_TIME_OFF', startDate: '2026-10-12', endDate: '2026-10-14', reason: 'Family visit', confidence: 0.9, summary: 'Request time off.' });
  assert.match(text, /Your time off · 3 days/);
  assert.match(text, /From Monday 12 October 2026 to Wednesday 14 October 2026/);
  assert.match(text, /Reason: Family visit/);
  const one = render({ intent: 'REQUEST_TIME_OFF', startDate: '2026-10-16', endDate: '2026-10-16', reason: null, confidence: 0.9, summary: 'x' });
  assert.match(one, /Your time off · 1 day Request Friday 16 October 2026$/);
  assert.doesNotMatch(one, /Reason/);
});

test('CREATE_SHIFT with a second segment spells out both parts, each with its full day', () => {
  const text = render({
    intent: 'CREATE_SHIFT',
    roleId: 'r',
    date: '2026-10-09',
    start: '11:00',
    end: '15:00',
    second: { start: '18:00', end: '01:00' },
    userId: 'u',
    confidence: 0.9,
    summary: 'Create a split shift.',
    details: { person: 'Alex Example', personRole: 'Waiter', role: 'Waiter' },
  });
  assert.match(text, /Waiter · Split shift, two parts/);
  assert.match(text, /1st: Friday 9 October 2026, 11:00 – 15:00/);
  assert.match(text, /2nd: Friday 9 October 2026, 18:00 – 01:00 \(ends Saturday\)/);
});

test('CREATE_SHIFT without a second segment is unchanged: one line, role then full day and times', () => {
  const text = render({
    intent: 'CREATE_SHIFT',
    roleId: 'r',
    date: '2026-10-10',
    start: '18:00',
    end: '02:00',
    userId: null,
    confidence: 0.9,
    summary: 'x',
    details: { person: null, role: 'Bartender' },
  });
  assert.match(text, /Open shift Draft Bartender · Saturday 10 October 2026, 18:00 – 02:00 \(ends Sunday\)/);
  assert.doesNotMatch(text, /1st:/);
});

test('PUBLISH_ROTA with counts: a stronger card stating the shifts changing and the people notified', () => {
  const text = render({ intent: 'PUBLISH_ROTA', weekStart: '2026-10-12', counts: { shiftsChanging: 12, peopleNotified: 8 }, confidence: 0.9, summary: 'Publish.' });
  assert.match(text, /^Before you publish/);
  assert.match(text, /Week of Monday 12 October 2026/);
  assert.match(text, /Shifts changing 12 People notified 8/);
  assert.match(text, /12 shifts will change and 8 people will be notified\./);
});

test('PUBLISH_ROTA from an older server (no counts) keeps the plain line', () => {
  const text = render({ intent: 'PUBLISH_ROTA', weekStart: '2026-10-12', confidence: 0.9, summary: 'Publish.' });
  assert.match(text, /^What will change Week of Monday 12 October 2026 Publish Rota goes live; staff are notified$/);
});

test('names from the server are text, never markup', () => {
  const html = renderToStaticMarkup(
    createElement(VoicePreview, {
      viewerName: 'Sam Sample',
      intent: {
        intent: 'CANCEL_SHIFT',
        shiftId: 's',
        confidence: 0.9,
        summary: 'x',
        details: { person: '<img src=x onerror=alert(1)>', personRole: null, date: '2026-10-09', start: '09:00', end: '17:00', role: null },
      },
    }),
  );
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('POST_ANNOUNCEMENT: the board card, and that everyone at the venue is notified', () => {
  const text = render({ intent: 'POST_ANNOUNCEMENT', content: 'Staff meeting Monday at 3.', confidence: 0.9, summary: 'Post this announcement.' });
  assert.match(text, /Staff meeting Monday at 3./);
  assert.match(text, /Everyone at your venue gets this as a notification./);
});
