import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAgainstContext } from './parseIntent.js';
import type { ParsedIntent } from './intentSchema.js';
import type { PromptContext } from './prompts.js';

// A made-up venue: two bars and a terrace; Omar is a bartender.
const ctx: PromptContext = {
  today: '2031-03-03',
  callerName: 'Dina Manager',
  callerShifts: [],
  staffDirectory: [
    { id: 'caller', fullName: 'Dina Manager', role: 'Manager' },
    { id: 'omar', fullName: 'Omar Haddad', role: 'Bartender' },
  ],
  roles: [{ id: 'bartender', name: 'Bartender' }],
  floorSections: [
    { id: 'main', label: 'Main Bar' },
    { id: 'pool', label: 'Pool Bar' },
    { id: 'terrace', label: 'Terrace' },
  ],
  weekShifts: [],
};
const caller = { id: 'caller', systemRole: 'MANAGER' as const, locationId: 'venue' };
const assign = (sectionId: string, period: 'AM' | 'PM'): ParsedIntent => ({
  intent: 'ASSIGN_SECTION', sectionId, staffId: 'omar', shiftDate: '2031-03-04', period, dutyLabel: null, targetUserName: 'Omar', confidence: 0.95, summary: 'x',
});
const check = (r: ParsedIntent, said: string) => checkAgainstContext(r, ctx, caller, 'Asia/Dubai', said);

test('a section the caller named once, matching the pick, goes to confirm with the full name and role', async () => {
  const r = await check(assign('terrace', 'PM'), 'Put Omar on the terrace tomorrow evening');
  assert.equal(r.intent, 'ASSIGN_SECTION');
  assert.deepEqual(r.intent === 'ASSIGN_SECTION' && r.details, { person: 'Omar Haddad', personRole: 'Bartender', section: 'Terrace' });
});

test('"the bar" with two bars is a Which-section question, even though the model picked one', async () => {
  const r = await check(assign('main', 'PM'), 'Put Omar on the bar tomorrow evening');
  assert.equal(r.intent, 'UNRECOGNIZED');
  assert.equal(r.summary, 'Which section did you mean?');
  const sections = r.intent === 'UNRECOGNIZED' ? (r.options ?? []).map((o) => o.intent === 'ASSIGN_SECTION' && o.details?.section) : [];
  assert.deepEqual(sections, ['Main Bar', 'Pool Bar']);
});

test('the caller said the terrace, the model picked a bar: both are put to the caller', async () => {
  const r = await check(assign('pool', 'PM'), 'Put Omar on the terrace tomorrow evening');
  assert.equal(r.intent === 'UNRECOGNIZED' && r.options?.length, 2);
});

test('"closing" read as a morning is a question; a section never said is left to the checked pick', async () => {
  const r = await check(assign('terrace', 'AM'), 'Put Omar on the terrace for closing tomorrow');
  assert.equal(r.intent, 'UNRECOGNIZED');
  assert.deepEqual(r.intent === 'UNRECOGNIZED' && r.options?.map((o) => o.intent === 'ASSIGN_SECTION' && o.period), ['PM', 'AM']);
  const quiet = await check(assign('terrace', 'PM'), 'Put Omar there tomorrow evening');
  assert.equal(quiet.intent, 'ASSIGN_SECTION');
});
