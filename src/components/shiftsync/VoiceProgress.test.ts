import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VoiceProgress } from './VoiceProgress';

const status = (html: string) => /<p role="status" aria-live="polite" class="sr-only">([^<]*)<\/p>/.exec(html)?.[1];

test('one live region says the step; the visible line is hidden from screen readers so nothing is read twice', () => {
  const html = renderToStaticMarkup(createElement(VoiceProgress, { step: 'ready', origin: 'voice' }));
  assert.equal(status(html), 'Ready to confirm');
  assert.match(html, /<p class="[^"]*" aria-hidden="true">Ready to confirm<\/p>/);
  assert.equal((html.match(/role="status"/g) ?? []).length, 1);
});

test('an out-of-date preview: the line asks for Update preview, a screen reader hears that the preview is out of date', () => {
  const html = renderToStaticMarkup(
    createElement(VoiceProgress, { step: 'ready', origin: 'typed', label: 'Editing: tap Update preview', announce: 'Editing, preview out of date', warning: true }),
  );
  assert.equal(status(html), 'Editing, preview out of date');
  assert.match(html, /<p class="[^"]*text-warning[^"]*" aria-hidden="true">Editing: tap Update preview<\/p>/);
});
