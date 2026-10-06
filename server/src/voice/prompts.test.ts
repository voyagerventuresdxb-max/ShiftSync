import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, type PromptContext } from './prompts.js';

const ctx: PromptContext = {
  today: '2031-03-03',
  callerName: 'Test Manager',
  callerShifts: [],
  staffDirectory: [
    { id: 'u1', fullName: 'Alex Example' },
    { id: 'u2', fullName: 'Omar Example' },
  ],
  pendingSwapRequests: [{ id: 's1', requesterName: 'Alex Example', coverName: 'Omar Example', shiftLabel: '2031-03-04 18:00-02:00' }],
  pendingJoinRequests: [{ id: 'j1', fullName: 'Riya Example', phone: '+971500000999' }],
  roles: [{ id: 'r1', name: 'Bartender' }],
  floorSections: [{ id: 'f1', label: 'Bar' }],
};

test('an applicant’s phone number never goes to the model; their name does', () => {
  const prompt = buildSystemPrompt('MANAGER', ctx);
  assert.match(prompt, /- j1 → Riya Example$/m);
  assert.ok(!prompt.includes('971500000999'));
  assert.ok(!prompt.includes('0000999'));
});

test('a pending swap names who was asked to cover', () => {
  assert.match(buildSystemPrompt('MANAGER', ctx), /- s1 → Alex Example, asking Omar Example to cover, 2031-03-04 18:00-02:00/);
});

test('a single matching pending request is called unambiguous; two possible matches are not guessed', () => {
  const prompt = buildSystemPrompt('MANAGER', ctx);
  assert.match(prompt, /exactly one pending request above matches .* unambiguous/);
  assert.match(prompt, /If two or more could match, respond with UNRECOGNIZED/);
});

test('section assignments say how to pick AM or PM', () => {
  assert.match(buildSystemPrompt('MANAGER', ctx), /"period" is AM for morning or lunch, and PM for afternoon, evening or night/);
});

test('a staff caller gets none of the manager-only lists or rules', () => {
  const staffPrompt = buildSystemPrompt('STAFF', { today: ctx.today, callerName: 'Test Staff', callerShifts: [], staffDirectory: ctx.staffDirectory });
  assert.ok(!staffPrompt.includes('Pending'));
  assert.ok(!staffPrompt.includes('ASSIGN_SECTION, "period"'));
});
