import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { issueSession } from '../lib/identity.js';
import { MANAGER_INTENTS, STAFF_INTENTS } from '../../../shared/voiceIntents.js';
import { addDays, cleanupFixture, seedFixture, snapshot, type Fixture } from '../../eval/voice/fixture.js';

/**
 * Voice safety matrix, on /execute (the only real boundary): every manager action from a staff
 * account; another venue's ids in every id-carrying field; and a Confirm sent after what the
 * preview showed changed on the server. Made-up venue (eval/voice/fixture.ts). Nothing here calls
 * a model.
 */

process.env.AI_MONTHLY_BUDGET_USD = '1000000';
process.env.AI_DAILY_CALL_LIMIT = '1000000';

const prisma = new PrismaClient();
let fx: Fixture;
let base = '';
let server: import('node:http').Server;

before(async () => {
  fx = await seedFixture(prisma);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await cleanupFixture(prisma, fx);
  await prisma.$disconnect();
});

async function execute(userId: string, intent: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const { plainToken } = await issueSession(userId);
  const res = await fetch(`${base}/api/voice/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plainToken}` },
    body: JSON.stringify({ transcript: 'voice safety matrix', intent: { confidence: 0.95, summary: 'test', ...intent } }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const both = () => snapshot(prisma, [fx.locationId, fx.otherLocationId]);
const monday = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return addDays(iso, -((d.getUTCDay() + 6) % 7));
};

/** A well-formed reading of each manager action against venue A's own records. */
function managerReading(intent: string): Record<string, unknown> {
  const tomorrow = addDays(fx.today, 1);
  const nextMonday = addDays(monday(fx.today), 7);
  switch (intent) {
    case 'APPROVE_SWAP':
    case 'DECLINE_SWAP':
      return { intent, swapRequestId: fx.swaps['alex+1'] };
    case 'APPROVE_JOIN':
    case 'DECLINE_JOIN':
      return { intent, joinRequestId: fx.joins.riya };
    case 'CREATE_SHIFT':
      return { intent, roleId: fx.roles.Bartender, userId: fx.users.omar, date: addDays(fx.today, 3), start: '18:00', end: '02:00' };
    case 'EDIT_SHIFT':
      return { intent, shiftId: fx.shifts['omar+2'], start: '12:00' };
    case 'CANCEL_SHIFT':
      return { intent, shiftId: fx.shifts['omar+2'] };
    case 'ASSIGN_SECTION':
      return { intent, sectionId: fx.sections.Terrace, staffId: fx.users.omar, shiftDate: tomorrow, period: 'PM', dutyLabel: null };
    case 'PUBLISH_ROTA':
      return { intent, weekStart: monday(fx.today) };
    case 'APPLY_ROTA_TEMPLATE':
      return { intent, templateId: fx.templates['Weekend Standard'], templateName: 'Weekend Standard', weekStart: nextMonday };
    case 'POST_ANNOUNCEMENT':
      return { intent, content: 'Staff meeting Monday at 3.' };
    case 'POST_SHOUTOUT':
      return { intent, targetUserId: fx.users.alex, targetUserName: 'Alex Morgan', content: 'Great job.' };
    default:
      throw new Error(`no reading for ${intent}`);
  }
}

const MANAGER_ONLY = MANAGER_INTENTS.filter((i) => !(STAFF_INTENTS as readonly string[]).includes(i));

test('a staff account is refused (403) for every manager action, and nothing changes in either venue', async () => {
  assert.equal(MANAGER_ONLY.length, 12);
  for (const intent of MANAGER_ONLY) {
    const before = await both();
    const res = await execute(fx.users.sam, managerReading(intent));
    assert.equal(res.status, 403, `${intent}: ${JSON.stringify(res.body)}`);
    assert.equal(await both(), before, `${intent} changed something`);
  }
});

test("another venue's ids in any field are refused, and nothing changes in either venue", async () => {
  const o = fx.other;
  const tomorrow = addDays(fx.today, 1);
  const attempts: Record<string, unknown>[] = [
    { intent: 'POST_SHOUTOUT', targetUserId: o.person, targetUserName: 'x', content: 'Great job.' },
    { intent: 'CREATE_SHIFT', roleId: o.role, userId: fx.users.omar, date: addDays(fx.today, 3), start: '18:00', end: '23:00' },
    { intent: 'CREATE_SHIFT', roleId: fx.roles.Server, userId: o.person, date: addDays(fx.today, 3), start: '18:00', end: '23:00' },
    { intent: 'EDIT_SHIFT', shiftId: o.shift, start: '12:00' },
    { intent: 'EDIT_SHIFT', shiftId: fx.shifts['omar+2'], userId: o.person },
    { intent: 'EDIT_SHIFT', shiftId: fx.shifts['omar+2'], roleId: o.role },
    { intent: 'CANCEL_SHIFT', shiftId: o.shift },
    { intent: 'ASSIGN_SECTION', sectionId: o.section, staffId: fx.users.omar, shiftDate: tomorrow, period: 'PM', dutyLabel: null },
    { intent: 'ASSIGN_SECTION', sectionId: fx.sections.Bar, staffId: o.person, shiftDate: tomorrow, period: 'PM', dutyLabel: null },
    { intent: 'APPLY_ROTA_TEMPLATE', templateId: o.template, templateName: 'x', weekStart: addDays(monday(fx.today), 7) },
  ];
  for (const intent of attempts) {
    const before = await both();
    const res = await execute(fx.users.hannah, intent);
    assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(intent)} → ${res.status}`);
    assert.equal(await both(), before, `${intent.intent} changed something`);
    assert.doesNotMatch(JSON.stringify(res.body), /Bartholomew|Quill|Rooftop|Sunday Brunch B|Sommelier/);
  }
  // A staff member's swap request naming another venue's person or shift.
  for (const intent of [
    { intent: 'REQUEST_SWAP', shiftId: o.shift, targetUserId: fx.users.alex, targetUserName: 'Alex Morgan', reason: null },
    { intent: 'REQUEST_SWAP', shiftId: fx.shifts['sam+1'], targetUserId: o.person, targetUserName: 'x', reason: null },
  ]) {
    const before = await both();
    const res = await execute(fx.users.sam, intent);
    assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(intent)} → ${res.status}`);
    assert.equal(await both(), before);
  }
});

test('a Confirm after the previewed record changed on the server is refused, not applied to something else', async () => {
  // The shift the preview showed was removed since.
  const gone = await prisma.shift.create({ data: { locationId: fx.locationId, roleId: fx.roles.Server, userId: fx.users.layla, date: new Date(`${addDays(fx.today, 6)}T00:00:00Z`), startTime: new Date(`${addDays(fx.today, 6)}T10:00:00Z`), endTime: new Date(`${addDays(fx.today, 6)}T14:00:00Z`) } });
  await prisma.shift.delete({ where: { id: gone.id } });
  for (const intent of [{ intent: 'EDIT_SHIFT', shiftId: gone.id, start: '12:00' }, { intent: 'CANCEL_SHIFT', shiftId: gone.id }]) {
    const before = await both();
    const res = await execute(fx.users.hannah, intent);
    assert.ok(res.status >= 400 && res.status < 500, `${intent.intent} on a removed shift → ${res.status}`);
    assert.equal(await both(), before);
  }

  // The swap was decided by someone else in the meantime.
  const first = await execute(fx.users.hannah, { intent: 'DECLINE_SWAP', swapRequestId: fx.swaps['alex+1'] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const before = await both();
  const again = await execute(fx.users.hannah, { intent: 'APPROVE_SWAP', swapRequestId: fx.swaps['alex+1'] });
  assert.ok(again.status >= 400 && again.status < 500, `approve after decline → ${again.status}`);
  assert.match(String(again.body.error), /already/i);
  assert.equal(await both(), before);

  // The person left (deactivated) after the preview named them.
  await prisma.user.update({ where: { id: fx.users.priya }, data: { isActive: false } });
  try {
    for (const intent of [
      { intent: 'POST_SHOUTOUT', targetUserId: fx.users.priya, targetUserName: 'Priya Raghunathan', content: 'Great job.' },
      { intent: 'CREATE_SHIFT', roleId: fx.roles.Host, userId: fx.users.priya, date: addDays(fx.today, 3), start: '12:00', end: '20:00' },
      { intent: 'ASSIGN_SECTION', sectionId: fx.sections.Bar, staffId: fx.users.priya, shiftDate: addDays(fx.today, 1), period: 'PM', dutyLabel: null },
    ]) {
      const b = await both();
      const res = await execute(fx.users.hannah, intent);
      assert.ok(res.status >= 400 && res.status < 500, `${intent.intent} for a person who left → ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(await both(), b, `${intent.intent} for a person who left changed something`);
    }
  } finally {
    await prisma.user.update({ where: { id: fx.users.priya }, data: { isActive: true } });
  }
});
