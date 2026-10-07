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

test('people: the name as said is always kept, an id only for exactly one match, and a missing or shared name is not a reason to give up', () => {
  const prompt = buildSystemPrompt('MANAGER', ctx);
  assert.match(prompt, /put the name exactly as you heard it in "targetUserName"/);
  assert.match(prompt, /Fill in that person's id only when exactly one person in the staff list above has that name/);
  assert.match(prompt, /Never choose between people who share a name, and never answer UNRECOGNIZED only because of a person's name/);
  assert.match(prompt, /"me" or "myself" means the caller, Test Manager/);
  assert.match(prompt, /For POST_SHOUTOUT: the recipient is the person being thanked or praised/);
  assert.match(prompt, /always say why in unrecognizedReason, as one short, friendly sentence to the caller/);
});

test('a staff caller gets the people rule (for swaps) but not the shout-out one', () => {
  const staffPrompt = buildSystemPrompt('STAFF', { today: ctx.today, callerName: 'Test Staff', callerShifts: [], staffDirectory: ctx.staffDirectory });
  assert.match(staffPrompt, /put the name exactly as you heard it/);
  assert.ok(!staffPrompt.includes('For POST_SHOUTOUT'));
});

test('every key is asked for, with the parts a new shift and a section move need named', () => {
  const prompt = buildSystemPrompt('MANAGER', ctx);
  assert.match(prompt, /Every key in the response is required/);
  assert.match(prompt, /for CREATE_SHIFT that is the role, date, start AND end; for ASSIGN_SECTION the section, date AND period/);
});
