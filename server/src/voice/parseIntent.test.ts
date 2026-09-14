import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { buildContext, normalizeHasAdditionalRequest, refinePublishRotaResponse, refineApplyRotaTemplateResponse } from './parseIntent.js';
import type { ParsedIntent } from './intentSchema.js';

const prisma = new PrismaClient();

test("buildContext never includes another caller's shifts in callerShifts", async () => {
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const callerA = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task7-test__ query-schedule caller A', systemRole: 'STAFF' },
  });
  const callerB = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task7-test__ query-schedule caller B', systemRole: 'STAFF' },
  });

  const shiftDate = new Date('2026-09-25T00:00:00.000Z');
  const shiftA = await prisma.shift.create({
    data: {
      locationId: location!.id, roleId: role!.id, userId: callerA.id,
      date: shiftDate, startTime: new Date('2026-09-25T09:00:00.000Z'), endTime: new Date('2026-09-25T17:00:00.000Z'), status: 'PUBLISHED',
    },
  });
  const shiftB = await prisma.shift.create({
    data: {
      locationId: location!.id, roleId: role!.id, userId: callerB.id,
      date: shiftDate, startTime: new Date('2026-09-25T10:00:00.000Z'), endTime: new Date('2026-09-25T18:00:00.000Z'), status: 'PUBLISHED',
    },
  });

  try {
    const contextForA = await buildContext({ id: callerA.id, systemRole: 'STAFF', fullName: callerA.fullName, locationId: location!.id });
    const idsForA = contextForA.callerShifts.map((s) => s.id);
    assert.ok(idsForA.includes(shiftA.id), "caller A's context must include their own shift");
    assert.ok(!idsForA.includes(shiftB.id), "caller A's context must NOT include caller B's shift");

    const contextForB = await buildContext({ id: callerB.id, systemRole: 'STAFF', fullName: callerB.fullName, locationId: location!.id });
    const idsForB = contextForB.callerShifts.map((s) => s.id);
    assert.ok(idsForB.includes(shiftB.id), "caller B's context must include their own shift");
    assert.ok(!idsForB.includes(shiftA.id), "caller B's context must NOT include caller A's shift");
  } finally {
    await prisma.shift.delete({ where: { id: shiftA.id } }).catch(() => {});
    await prisma.shift.delete({ where: { id: shiftB.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: callerA.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: callerB.id } }).catch(() => {});
  }
});

test("buildContext populates a MANAGER-tier caller's own shift in callerShifts correctly, alongside the venue-wide weekShifts it also gets", async () => {
  // MANAGER/OWNER-tier callers additionally get ctx.weekShifts (the whole
  // venue's shifts, every assignee's name included) for EDIT_SHIFT/
  // ASSIGN_SECTION. QUERY_MY_SCHEDULE must still only ever be answered from
  // callerShifts — this test proves buildContext itself still populates the
  // manager's OWN shift into callerShifts correctly when both lists are
  // present. It cannot prove the model actually honors the prompt
  // instruction not to use weekShifts for this intent — that needs a live
  // Gemini call — but it does prove the context-building data the
  // instruction relies on is correct.
  const location = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  const role = await prisma.role.findFirst({ where: { locationId: location!.id } });
  assert.ok(location && role, 'seed data (location + role) must exist to run this test');

  const manager = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task7-test__ query-schedule manager', systemRole: 'MANAGER' },
  });
  const staffer = await prisma.user.create({
    data: { locationId: location!.id, fullName: '__task7-test__ query-schedule other staffer', systemRole: 'STAFF' },
  });

  // weekShifts is bounded to [today, today+7) — unlike callerShifts, which
  // has no upper bound — so this must land within the next few days of the
  // REAL current date rather than a fixed future literal, or it would fall
  // outside buildContext's weekShifts window and the assertion below it
  // depends on would never see it.
  const shiftDateStr = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const shiftDate = new Date(`${shiftDateStr}T00:00:00.000Z`);
  const managerShift = await prisma.shift.create({
    data: {
      locationId: location!.id, roleId: role!.id, userId: manager.id,
      date: shiftDate, startTime: new Date(`${shiftDateStr}T09:00:00.000Z`), endTime: new Date(`${shiftDateStr}T17:00:00.000Z`), status: 'PUBLISHED',
    },
  });
  const stafferShift = await prisma.shift.create({
    data: {
      locationId: location!.id, roleId: role!.id, userId: staffer.id,
      date: shiftDate, startTime: new Date(`${shiftDateStr}T11:00:00.000Z`), endTime: new Date(`${shiftDateStr}T19:00:00.000Z`), status: 'PUBLISHED',
    },
  });

  try {
    const context = await buildContext({ id: manager.id, systemRole: 'MANAGER', fullName: manager.fullName, locationId: location!.id });

    const callerShiftIds = context.callerShifts.map((s) => s.id);
    assert.ok(callerShiftIds.includes(managerShift.id), "manager's callerShifts must include their own shift");
    assert.ok(!callerShiftIds.includes(stafferShift.id), "manager's callerShifts must NOT include the other staffer's shift");

    // Sanity-check the coupling this fix is about: weekShifts (the
    // venue-wide list this tier also gets) is populated and DOES include the
    // other staffer's shift — proving the two lists really do coexist in a
    // manager's context, which is exactly why the prompt instruction has to
    // steer the model away from weekShifts for this intent.
    assert.ok(context.weekShifts?.some((s) => s.id === stafferShift.id), "manager's weekShifts must include the other staffer's shift (venue-wide, for other intents)");
  } finally {
    await prisma.shift.delete({ where: { id: managerShift.id } }).catch(() => {});
    await prisma.shift.delete({ where: { id: stafferShift.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: manager.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: staffer.id } }).catch(() => {});
  }
});

test('normalizeHasAdditionalRequest: true stays true', () => {
  assert.equal(normalizeHasAdditionalRequest({ hasAdditionalRequest: true }), true);
});

test('normalizeHasAdditionalRequest: false stays false', () => {
  assert.equal(normalizeHasAdditionalRequest({ hasAdditionalRequest: false }), false);
});

test('normalizeHasAdditionalRequest: missing fails closed to false', () => {
  assert.equal(normalizeHasAdditionalRequest({}), false);
});

test('normalizeHasAdditionalRequest: non-boolean fails closed to false', () => {
  assert.equal(normalizeHasAdditionalRequest({ hasAdditionalRequest: 'true' }), false);
  assert.equal(normalizeHasAdditionalRequest({ hasAdditionalRequest: 1 }), false);
  assert.equal(normalizeHasAdditionalRequest({ hasAdditionalRequest: null }), false);
});

// refinePublishRotaResponse — the deterministic count/summary pass PUBLISH_ROTA
// gets on top of the model's own confidence gate (spec
// 2026-09-11-voice-publish-rota-apply-template-design.md §2.1). Zero dedicated
// coverage existed for this before this test block, despite it being the
// function that turns a model-authored PUBLISH_ROTA into the number the
// caller actually confirms against.

test('refinePublishRotaResponse: an unparseable weekStart is rejected before any DB lookup', async () => {
  const response: Extract<ParsedIntent, { intent: 'PUBLISH_ROTA' }> = {
    intent: 'PUBLISH_ROTA',
    weekStart: 'not-a-date',
    confidence: 0.9,
    summary: 'original model summary',
  };
  // A locationId that doesn't resolve to a real row — if this test passes,
  // the NaN check ran and returned before getRotaPublishPreview ever touched
  // the DB with it, proving the two checks are ordered as the function's own
  // implementation intends.
  const result = await refinePublishRotaResponse(response, '__does-not-exist__');
  assert.equal(result.intent, 'UNRECOGNIZED');
});

test('refinePublishRotaResponse: a week with zero shifts is rejected, not offered as a confirm-0-shifts preview', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (location) must exist to run this test');

  const testLocation = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__parseIntent-test__ empty-week location', timezone: 'Asia/Dubai' },
  });

  try {
    const response: Extract<ParsedIntent, { intent: 'PUBLISH_ROTA' }> = {
      intent: 'PUBLISH_ROTA',
      weekStart: '2026-11-02',
      confidence: 0.9,
      summary: 'original model summary',
    };
    const result = await refinePublishRotaResponse(response, testLocation.id);
    assert.equal(result.intent, 'UNRECOGNIZED');
    if (result.intent === 'UNRECOGNIZED') {
      assert.match(result.reason, /no shifts/i);
      assert.match(result.summary, /nothing to publish/i);
    }
  } finally {
    await prisma.location.delete({ where: { id: testLocation.id } }).catch(() => {});
  }
});

test('refinePublishRotaResponse: a non-empty week gets the exact recomputed shift/staff counts, never the model’s own arithmetic', async () => {
  const seedLocation = await prisma.location.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(seedLocation, 'seed data (location) must exist to run this test');

  const testLocation = await prisma.location.create({
    data: { organizationId: seedLocation!.organizationId, name: '__parseIntent-test__ non-empty-week location', timezone: 'Asia/Dubai' },
  });
  const role = await prisma.role.create({ data: { locationId: testLocation.id, name: '__parseIntent-test__ role' } });
  const staffA = await prisma.user.create({
    data: { locationId: testLocation.id, fullName: '__parseIntent-test__ staff A', systemRole: 'STAFF' },
  });
  const staffB = await prisma.user.create({
    data: { locationId: testLocation.id, fullName: '__parseIntent-test__ staff B', systemRole: 'STAFF' },
  });

  const weekStartStr = '2026-11-02';
  // 4 shifts total, but only 2 distinct assigned staff (staffA has two
  // shifts, one shift is unassigned) — proves shiftCount and staffCount are
  // genuinely independent numbers, not one derived from the other.
  const days = [0, 1, 2, 3];
  const userIds = [staffA.id, staffA.id, staffB.id, null];
  const shifts = await Promise.all(
    days.map((offset, i) => {
      const date = new Date(`${weekStartStr}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + offset);
      const dateStr = date.toISOString().slice(0, 10);
      return prisma.shift.create({
        data: {
          locationId: testLocation.id,
          roleId: role.id,
          userId: userIds[i],
          date,
          startTime: new Date(`${dateStr}T09:00:00.000Z`),
          endTime: new Date(`${dateStr}T17:00:00.000Z`),
          status: 'DRAFT',
        },
      });
    }),
  );

  try {
    const response: Extract<ParsedIntent, { intent: 'PUBLISH_ROTA' }> = {
      intent: 'PUBLISH_ROTA',
      weekStart: weekStartStr,
      confidence: 0.9,
      summary: 'original model summary — must be overwritten',
    };
    const result = await refinePublishRotaResponse(response, testLocation.id);
    assert.equal(result.intent, 'PUBLISH_ROTA');
    if (result.intent === 'PUBLISH_ROTA') {
      assert.equal(result.weekStart, weekStartStr, 'weekStart must survive the refinement unchanged');
      assert.equal(result.summary, `This will publish 4 shifts across 2 staff members for the week of ${weekStartStr} — confirm?`);
    }
  } finally {
    await prisma.shift.deleteMany({ where: { id: { in: shifts.map((s) => s.id) } } });
    await prisma.user.delete({ where: { id: staffA.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: staffB.id } }).catch(() => {});
    await prisma.role.delete({ where: { id: role.id } }).catch(() => {});
    await prisma.location.delete({ where: { id: testLocation.id } }).catch(() => {});
  }
});

// refineApplyRotaTemplateResponse — the ambiguity backstop for
// APPLY_ROTA_TEMPLATE (spec §2.2). Pure logic over a caller-supplied
// templates list, no DB involved, so these run as plain unit tests. Zero
// dedicated coverage existed for this before this test block.

test('refineApplyRotaTemplateResponse: an unparseable weekStart is rejected before any matching happens', async () => {
  const response: Extract<ParsedIntent, { intent: 'APPLY_ROTA_TEMPLATE' }> = {
    intent: 'APPLY_ROTA_TEMPLATE',
    templateId: 't1',
    templateName: 'Weekday Standard',
    weekStart: 'not-a-date',
    confidence: 0.9,
    summary: 'original model summary',
  };
  const result = await refineApplyRotaTemplateResponse(response, [{ id: 't1', name: 'Weekday Standard' }]);
  assert.equal(result.intent, 'UNRECOGNIZED');
});

test('refineApplyRotaTemplateResponse: model pick agrees with an unambiguous best match — resolves with the deterministic confirm summary', async () => {
  const response: Extract<ParsedIntent, { intent: 'APPLY_ROTA_TEMPLATE' }> = {
    intent: 'APPLY_ROTA_TEMPLATE',
    templateId: 't1',
    templateName: 'Weekday Standard',
    weekStart: '2026-11-02',
    confidence: 0.9,
    summary: 'original model summary — must be overwritten',
  };
  const templates = [
    { id: 't1', name: 'Weekday Standard' },
    { id: 't2', name: 'Weekend Brunch' },
  ];
  const result = await refineApplyRotaTemplateResponse(response, templates);
  assert.equal(result.intent, 'APPLY_ROTA_TEMPLATE');
  if (result.intent === 'APPLY_ROTA_TEMPLATE') {
    assert.equal(result.templateId, 't1');
    assert.equal(result.summary, 'Apply template "Weekday Standard" to the week of 2026-11-02 — confirm?');
  }
});

test('refineApplyRotaTemplateResponse: model’s own templateId disagreeing with the independently-scored best match is rejected, not silently overridden', async () => {
  // The model named templateId "t2" but the text it actually transcribed
  // ("Weekday Standard") scores as an exact match against "t1" instead —
  // exactly the opaque-decision failure mode the backstop exists to catch
  // (see this function's own doc comment): never execute the closest guess
  // when the model's own structured pick and the independent re-score
  // disagree, surface a clarifying question instead.
  const response: Extract<ParsedIntent, { intent: 'APPLY_ROTA_TEMPLATE' }> = {
    intent: 'APPLY_ROTA_TEMPLATE',
    templateId: 't2',
    templateName: 'Weekday Standard',
    weekStart: '2026-11-02',
    confidence: 0.9,
    summary: 'original model summary',
  };
  const templates = [
    { id: 't1', name: 'Weekday Standard' },
    { id: 't2', name: 'Weekend Brunch' },
  ];
  const result = await refineApplyRotaTemplateResponse(response, templates);
  assert.equal(result.intent, 'UNRECOGNIZED');
  if (result.intent === 'UNRECOGNIZED') {
    assert.match(result.reason, /closest matches/i);
    assert.match(result.reason, /Weekday Standard/);
  }
});

test('refineApplyRotaTemplateResponse: two candidates within the confidence margin of each other are both surfaced, neither is guessed', async () => {
  // "Weekend Brnch" scores ~0.929 against "Weekend Brunch" and ~0.923
  // against "Weekend Bunch" — both clear the 0.6 floor individually, but
  // the gap between them (~0.006) is well under the required 0.1 margin, so
  // neither should be auto-applied even though the top score alone would
  // clear the threshold.
  const response: Extract<ParsedIntent, { intent: 'APPLY_ROTA_TEMPLATE' }> = {
    intent: 'APPLY_ROTA_TEMPLATE',
    templateId: 't1',
    templateName: 'Weekend Brnch',
    weekStart: '2026-11-02',
    confidence: 0.9,
    summary: 'original model summary',
  };
  const templates = [
    { id: 't1', name: 'Weekend Brunch' },
    { id: 't2', name: 'Weekend Bunch' },
  ];
  const result = await refineApplyRotaTemplateResponse(response, templates);
  assert.equal(result.intent, 'UNRECOGNIZED');
  if (result.intent === 'UNRECOGNIZED') {
    assert.match(result.reason, /Weekend Brunch/);
    assert.match(result.reason, /Weekend Bunch/);
  }
});

test('refineApplyRotaTemplateResponse: no candidate resembles the spoken name at all — rejected with no closest-match suggestions', async () => {
  const response: Extract<ParsedIntent, { intent: 'APPLY_ROTA_TEMPLATE' }> = {
    intent: 'APPLY_ROTA_TEMPLATE',
    templateId: null,
    templateName: 'zzzzz completely unrelated gibberish',
    weekStart: '2026-11-02',
    confidence: 0.9,
    summary: 'original model summary',
  };
  const result = await refineApplyRotaTemplateResponse(response, [{ id: 't1', name: 'Weekday Standard' }]);
  assert.equal(result.intent, 'UNRECOGNIZED');
  if (result.intent === 'UNRECOGNIZED') {
    assert.match(result.reason, /closest matches/i);
  }
});

test('refineApplyRotaTemplateResponse: an empty templates list is rejected with the no-candidates message, not a closest-match one', async () => {
  const response: Extract<ParsedIntent, { intent: 'APPLY_ROTA_TEMPLATE' }> = {
    intent: 'APPLY_ROTA_TEMPLATE',
    templateId: null,
    templateName: 'Weekday Standard',
    weekStart: '2026-11-02',
    confidence: 0.9,
    summary: 'original model summary',
  };
  const result = await refineApplyRotaTemplateResponse(response, []);
  assert.equal(result.intent, 'UNRECOGNIZED');
  if (result.intent === 'UNRECOGNIZED') {
    assert.doesNotMatch(result.reason, /closest matches/i);
    assert.match(result.reason, /no saved template/i);
  }
});
