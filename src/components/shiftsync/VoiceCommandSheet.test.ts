import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { ParsedIntent } from '@/api/voice';
import { VoiceCommandSheet } from './VoiceCommandSheet';
import { VoiceComposer } from './VoiceComposer';
import { micProblem, offlineProblem } from '@/lib/voiceErrors';

type SheetProps = ComponentProps<typeof VoiceCommandSheet>;
const noop = () => {};

function sheet(intent: ParsedIntent, extra: Partial<SheetProps> = {}): string {
  const props: SheetProps = {
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
    viewerName: 'Sam Sample',
    canManageStaff: true,
    examples: ["Who's working tonight?", 'Any pending requests?'],
    ...extra,
  };
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(VoiceCommandSheet, props)));
}

/** The visible words, in order. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** Every button's text, in order. */
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]!));

test('a read renders the answer as a list — primary, secondary, tertiary — with Done and no Confirm', () => {
  const html = sheet({
    intent: 'WHO_IS_WORKING',
    confidence: 0.9,
    summary: 'Three people are working tonight.',
    answer: {
      title: 'Working tonight — Thursday 8 October 2026',
      items: [
        { primary: 'Alex Example', secondary: 'Bartender', tertiary: '18:00 – 02:00' },
        { primary: 'Sam Sample', secondary: 'Waiter' },
      ],
      emptyText: 'Nobody is working tonight.',
    },
  });
  const words = text(html);
  assert.match(words, /^Who's working Working tonight — Thursday 8 October 2026 I heard “what was said” Alex Example Bartender 18:00 – 02:00 Sam Sample Waiter/);
  assert.match(words, /Here's the answer/);
  assert.doesNotMatch(words, /Nobody is working tonight/);
  assert.deepEqual(buttons(html), ['Done']);
});

test('an empty answer shows the server\'s empty text', () => {
  const html = sheet({ intent: 'PENDING_REQUESTS', confidence: 0.9, summary: 'x', answer: { title: 'Pending requests', items: [], emptyText: 'No requests are waiting.' } });
  assert.match(text(html), /Pending requests I heard “what was said” No requests are waiting\./);
  assert.deepEqual(buttons(html), ['Done']);
});

test('answer text is rendered as text, never as HTML', () => {
  const html = sheet({
    intent: 'RECENT_ANNOUNCEMENTS',
    confidence: 0.9,
    summary: 'x',
    answer: { title: '<b>Announcements</b>', items: [{ primary: '<img src=x onerror=alert(1)>', secondary: '<script>alert(2)</script>' }], emptyText: '' },
  });
  assert.doesNotMatch(html, /<img|<script|<b>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
});

test('an older QUERY_MY_SCHEDULE (no answer) still shows its sentence with Got it', () => {
  const html = sheet({ intent: 'QUERY_MY_SCHEDULE', confidence: 0.9, summary: 'You have no shifts scheduled this week.' });
  assert.match(text(html), /^Your schedule You have no shifts scheduled this week\./);
  assert.deepEqual(buttons(html), ['Got it']);
});

test("DECLINED: the server's message and a link to its screen, no Confirm", () => {
  const html = sheet({
    intent: 'DECLINED',
    category: 'people_deactivate_delete',
    message: "Removing or deactivating someone isn't done by voice. Do it in People.",
    screen: { label: 'People', path: '/people' },
    summary: 'Not by voice.',
    confidence: 1,
  });
  assert.match(text(html), /^Not by voice Removing or deactivating someone isn't done by voice\. Do it in People\. Open People/);
  assert.match(html, /<a[^>]+href="\/people"/);
  assert.deepEqual(buttons(html), ['Got it']);
});

test('DECLINED without a screen, or with a path outside the app, has no link', () => {
  const base = { intent: 'DECLINED' as const, category: 'payroll_wps', message: "Payroll and WPS aren't handled by voice.", summary: 'x', confidence: 1 };
  assert.doesNotMatch(sheet({ ...base, screen: null }), /<a /);
  assert.doesNotMatch(sheet({ ...base, screen: { label: 'Elsewhere', path: '//evil.example' } }), /<a /);
});

test('PUBLISH_ROTA with counts: the stronger card and a Confirm that says who is notified', () => {
  const html = sheet({ intent: 'PUBLISH_ROTA', weekStart: '2026-10-12', counts: { shiftsChanging: 12, peopleNotified: 8 }, confidence: 0.9, summary: 'Publish next week.' });
  assert.match(text(html), /12 shifts will change and 8 people will be notified\./);
  assert.match(text(html), /Ready to confirm/);
  assert.deepEqual(buttons(html), ['Confirm: publish and notify 8 people', 'Edit', 'Cancel']);
});

test('CANCEL_SHIFT: the dismiss button keeps the shift, so it never reads like the cancellation itself', () => {
  const html = sheet({
    intent: 'CANCEL_SHIFT',
    shiftId: 's',
    confidence: 0.9,
    summary: "Cancel Alex Example's Friday shift.",
    details: { person: 'Alex Example', personRole: 'Bartender', date: '2026-10-09', start: '18:00', end: '23:00', role: 'Bartender' },
  });
  assert.match(text(html), /^Cancel shift Cancel Alex Example's Friday shift\./);
  assert.deepEqual(buttons(html), ['Confirm: cancel this shift', 'Edit', 'Keep shift']);
});

test('while it runs the step says "Doing it…"; a Confirm that did not get through says why and can be tapped again', () => {
  const intent: ParsedIntent = { intent: 'POST_ANNOUNCEMENT', content: 'Staff meeting Monday', confidence: 0.9, summary: 'Post an announcement.' };
  assert.match(text(sheet(intent, { executing: true })), /Doing it…/);
  const html = sheet(intent, { problem: offlineProblem('execute') });
  assert.match(text(html), /You're offline Nothing was sent and nothing changed\. Reconnect, then tap Confirm again\./);
  assert.match(html, /role="alert"/);
  assert.deepEqual(buttons(html), ['Confirm', 'Edit', 'Cancel']);
});

test("not understood: the editable words, example phrases for the role (which don't send), Try again", () => {
  const html = sheet({ intent: 'UNRECOGNIZED', reason: 'Say it again, or fix what I heard and try again.', summary: "I didn't catch what you'd like to do." });
  assert.match(text(html), /I heard — fix it and try again/);
  assert.match(html, /aria-label="Examples to try"/);
  assert.deepEqual(buttons(html), ["Who's working tonight?", 'Any pending requests?', 'Try again', 'Cancel']);
  // A typed command says so.
  assert.match(text(sheet({ intent: 'UNRECOGNIZED', reason: 'x', summary: 'y' }, { origin: 'typed' })), /You typed — fix it and try again/);
});

test('no examples when the question is about a name or a missing part', () => {
  const person = sheet({ intent: 'UNRECOGNIZED', reason: 'Check the name.', summary: "I couldn't find Rana on your team.", person: { heard: 'Rana', status: 'missing' } });
  assert.doesNotMatch(person, /Examples to try/);
  const incomplete = sheet({ intent: 'UNRECOGNIZED', reason: 'x', summary: 'What time does it end?', incomplete: { intent: 'CREATE_SHIFT', missing: ['end'] } });
  assert.doesNotMatch(incomplete, /Examples to try/);
});

test('the typed command box: plain heading, the examples, Send; a problem shows above it with how to fix it', () => {
  const render = (props: Partial<ComponentProps<typeof VoiceComposer>>) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(VoiceComposer, { open: true, value: '', onChange: noop, problem: null, sending: false, examples: ['When am I working this week?'], onSend: noop, onCancel: noop, ...props }),
      ),
    );
  const plain = render({});
  assert.match(text(plain), /^Type a command What would you like to do\? Type what you'd say Or try When am I working this week\?/);
  assert.deepEqual(buttons(plain), ['When am I working this week?', 'Send', 'Cancel']);

  const denied = render({ problem: micProblem(new DOMException('no', 'NotAllowedError')), value: 'Book Friday off' });
  assert.match(text(denied), /Microphone is off ShiftSync isn't allowed to use the microphone/);
  assert.match(text(denied), /Website Settings → Microphone → Allow/);
  assert.match(text(denied), /Type it instead/);
  assert.match(denied, /role="alert"/);

  assert.match(text(render({ sending: true, value: 'x' })), /Understanding…/);
  assert.equal(render({ open: false }), '');
});
