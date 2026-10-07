import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PersonPreview, PreviewRow } from '../../api/schedules';
import {
  buildConfirmRequest,
  formatWeekLabel,
  headerLine,
  readerLabel,
  hardToReadNotice,
  importResultLines,
  initialChoice,
  initialReviewState,
  personNotes,
  possibleMatchQuestion,
  reviewBlockers,
  reviewPeople,
  reviewWeek,
  shiftSummary,
  timeQuestions,
  type ReviewState,
} from './reviewModel';

function row(overrides: Partial<PreviewRow>): PreviewRow {
  return {
    rowNumber: 1,
    employeeName: 'Ava Thornton',
    role: 'Waiter',
    date: '2026-08-24',
    startTime: '18:00',
    endTime: '02:00',
    overnight: true,
    breakMinutes: 0,
    managerNotes: null,
    status: 'new_employee',
    issues: [],
    ...overrides,
  };
}

function person(overrides: Partial<PersonPreview>): PersonPreview {
  return {
    personKey: 'p1',
    name: 'Ava Thornton',
    normalizedName: 'ava thornton',
    roleLabel: 'Waiter',
    resolvedRoleId: 'r1',
    section: null,
    status: 'new',
    matchedUserId: null,
    flags: [],
    shiftCount: 1,
    rowNumbers: [1],
    sourceRows: [],
    ...overrides,
  };
}

test('header counts people, not rows, and lists unread rows', () => {
  assert.equal(headerLine(12, 0), 'Found 12 people');
  assert.equal(headerLine(1, 1), "Found 1 person · 1 row couldn't be read");
  assert.equal(headerLine(10, 2), "Found 10 people · 2 rows couldn't be read");
});

test('week label reads like the printed roster', () => {
  assert.equal(formatWeekLabel('2026-08-24'), 'Week of Mon 24 Aug 2026');
});

test('an older server without people: rows are grouped into one person each (source row, else name)', () => {
  const people = reviewPeople({
    preview: [
      row({ rowNumber: 1, sourceRowIndex: 3 }),
      row({ rowNumber: 2, sourceRowIndex: 3, date: '2026-08-25' }),
      row({ rowNumber: 3, sourceRowIndex: 4, employeeName: 'Ben Okafor', status: 'unmatched_role' }),
    ],
  });
  assert.equal(people.length, 2);
  assert.deepEqual(people[0]!.rowNumbers, [1, 2]);
  assert.ok(people[1]!.flags.some((f) => f.kind === 'role_unresolved'));
});

test('without a server week, the week is the Monday of the earliest shift and needs no confirmation', () => {
  const week = reviewWeek({ preview: [row({ date: '2026-08-27' }), row({ date: '2026-08-26' })] });
  assert.equal(week?.weekStart, '2026-08-24');
  assert.equal(week?.needsConfirmation, false);
});

test('a close name is never preselected: it stays unanswered and blocks Confirm until the manager answers', () => {
  const p = person({ status: 'needs_decision', suggestedAction: 'create', suggestedUserId: null, flags: [{ kind: 'possible_match', candidates: [{ userId: 'u1', fullName: 'Bastian Rao' }] }] });
  const choice = initialChoice(p);
  assert.equal(choice.undecided, true);
  const state = initialReviewState([p], null);
  assert.deepEqual(reviewBlockers([p], null, state), ['Answer “same person?” for 1 person']);
  state.choices.p1 = { ...state.choices.p1!, action: 'link', userId: 'u1', undecided: false };
  assert.deepEqual(reviewBlockers([p], null, state), []);
  assert.deepEqual(buildConfirmRequest([p], [], state).people, [{ personKey: 'p1', action: 'link', userId: 'u1' }]);
});

test('a person only the AI reader found, with no shifts, is never imported without an answer', () => {
  const ghost = person({ status: 'new', suggestedAction: 'create', suggestedUserId: null, shiftCount: 0, flags: [{ kind: 'ai_only' }] });
  const real = person({ personKey: 'p2', name: 'Lena Ortiz', status: 'new', suggestedAction: 'create', suggestedUserId: null });
  assert.equal(initialChoice(ghost).undecided, true);
  const state = initialReviewState([ghost, real], null);
  assert.deepEqual(reviewBlockers([ghost, real], null, state), ['Decide whether to import 1 person only the AI reader found']);
  state.choices.p1 = { ...state.choices.p1!, action: 'skip', undecided: false };
  assert.deepEqual(reviewBlockers([ghost, real], null, state), []);
  assert.deepEqual(buildConfirmRequest([ghost, real], [], state).people?.find((p) => p.personKey === 'p1'), { personKey: 'p1', action: 'skip' });
  // With shifts, or found by the table reader too, nothing is asked.
  assert.equal(initialChoice(person({ status: 'new', suggestedAction: 'create', suggestedUserId: null, shiftCount: 3, flags: [{ kind: 'ai_only' }] })).undecided, undefined);
  assert.equal(initialChoice(person({ status: 'new', suggestedAction: 'create', suggestedUserId: null, shiftCount: 0, flags: [] })).undecided, undefined);
});

test('preselection follows the server suggestion; a close match is "same person" only when suggested', () => {
  assert.deepEqual(initialChoice(person({ status: 'matched', matchedUserId: 'u1', suggestedAction: 'link', suggestedUserId: 'u1' })).action, 'link');
  assert.deepEqual(initialChoice(person({ status: 'needs_decision', suggestedAction: 'create', suggestedUserId: null })).action, 'create');
  assert.equal(initialChoice(person({ matchedUserId: 'u9' })).userId, 'u9', 'older server: an exact match links');
});

test('flags read in human words', () => {
  const p = person({
    flags: [
      { kind: 'ai_only' },
      { kind: 'two_sections', sections: ['WAITERS', 'BAR'] },
      { kind: 'duplicate_name', personKeys: ['p1', 'p2'] },
    ],
  });
  const texts = personNotes(p, []).map((n) => n.text);
  assert.ok(texts.includes('Found by the AI reader only — check it'));
  assert.ok(texts.includes('Listed in two sections: WAITERS and BAR'));
  assert.ok(!texts.includes('Listed twice'), 'two sections already says it');
  assert.ok(personNotes(person({ flags: [{ kind: 'duplicate_name', personKeys: ['a', 'b'] }] }), []).some((n) => n.text === 'Listed twice'));
  assert.ok(personNotes(person({ flags: [{ kind: 'table_only' }] }), []).some((n) => n.text === 'Found by the table reader only'));
  assert.ok(
    personNotes(person({ flags: [{ kind: 'name_differs', spellings: ['Saffaiya Okafor', 'Saffiya Okafor'] }] }), []).some(
      (n) => n.tone === 'check' && n.text === 'The name was read two ways: “Saffaiya Okafor” or “Saffiya Okafor” — check the spelling',
    ),
  );
  const q = possibleMatchQuestion(person({ flags: [{ kind: 'possible_match', candidates: [{ userId: 'u1', fullName: 'Maria Lopez' }] }] }));
  assert.equal(q?.text, 'Possibly the same person as Maria Lopez — same person?');
});

test('times differ: one question per shift, first option is what the row says', () => {
  const rows = [
    row({
      rowNumber: 7,
      flags: ['times_differ'],
      alternatives: [
        { reader: 'table', startTime: '18:00', endTime: '02:00', overnight: true },
        { reader: 'ai', startTime: '18:30', endTime: '02:00', overnight: true },
      ],
    }),
  ];
  const [q] = timeQuestions(rows);
  assert.equal(q?.text, 'Mon 24 Aug — times differ: 18:00–02:00 or 18:30–02:00?');
  assert.deepEqual(
    q?.options.map((o) => o.label),
    ['18:00–02:00', '18:30–02:00'],
  );
});

test('shift summary', () => {
  assert.equal(shiftSummary([row({ date: '2026-08-24' }), row({ date: '2026-08-29' })]), 'Mon–Sat · 2 shifts');
  assert.equal(shiftSummary([]), 'No shifts this week');
});

test('blockers: an unconfirmed week, a "two people" entry still sharing the name, everyone skipped', () => {
  const people = [
    person({ personKey: 'a', flags: [{ kind: 'duplicate_name', personKeys: ['a', 'b'] }], status: 'needs_decision' }),
    person({ personKey: 'b', flags: [{ kind: 'duplicate_name', personKeys: ['a', 'b'] }], status: 'needs_decision', rowNumbers: [2] }),
  ];
  const week = { weekStart: '2026-08-24', weekEnd: '2026-08-30', source: 'weekday_only' as const, printedLabel: null, needsConfirmation: true, reason: 'No dates printed' };
  const state = initialReviewState(people, week);
  assert.deepEqual(reviewBlockers(people, week, state), ['Confirm the week first']);

  const confirmed: ReviewState = { ...state, weekConfirmed: true, separate: ['b'] };
  assert.deepEqual(reviewBlockers(people, week, confirmed), ['Give the other "Ava Thornton" a different name']);
  const renamed: ReviewState = { ...confirmed, choices: { ...confirmed.choices, b: { ...confirmed.choices.b!, name: 'Ava Thornton Jr' } } };
  assert.deepEqual(reviewBlockers(people, week, renamed), []);

  const skipped: ReviewState = { ...renamed, choices: { a: { ...renamed.choices.a!, action: 'skip' as const }, b: { ...renamed.choices.b!, action: 'skip' as const } } };
  assert.deepEqual(reviewBlockers(people, week, skipped), ['Nothing to import — everyone is skipped']);
  assert.deepEqual(reviewBlockers(people, null, { ...renamed }, { anomaliesOutstanding: 2 }), ['2 unclear cells to look at first']);
  const empty = initialReviewState([], null);
  assert.deepEqual(reviewBlockers([], null, empty), ['Nobody to import yet — add someone below, or upload another file']);
  assert.deepEqual(reviewBlockers([], null, { ...empty, added: [{ name: 'Dara Quinn', roleName: null }] }), []);
});

test('confirm request: decisions per person, bulk role, added people, the confirmed week and time picks', () => {
  const people = [
    person({ personKey: 'a', status: 'matched', matchedUserId: 'u1', suggestedAction: 'link', suggestedUserId: 'u1' }),
    person({ personKey: 'b', name: 'Ben Okafor', rowNumbers: [2], flags: [{ kind: 'role_unresolved' }] }),
    person({ personKey: 'c', name: 'Cleo Varga', rowNumbers: [3] }),
  ];
  const rows = [
    row({ rowNumber: 1 }),
    row({
      rowNumber: 2,
      flags: ['times_differ'],
      alternatives: [
        { reader: 'table', startTime: '18:00', endTime: '02:00', overnight: true },
        { reader: 'ai', startTime: '18:30', endTime: '02:00', overnight: true },
      ],
    }),
    row({ rowNumber: 3 }),
  ];
  const state = initialReviewState(people, null);
  state.weekStart = '2026-08-31';
  state.choices.b = { ...state.choices.b!, roleName: 'Sommelier' };
  state.choices.c = { ...state.choices.c!, action: 'skip' };
  state.added = [{ name: 'Dara Quinn', roleName: 'Host' }];
  state.timePicks = { 2: 1 };
  const req = buildConfirmRequest(people, rows, state, { createdById: 'm1' });
  assert.deepEqual(req.people, [
    { personKey: 'a', action: 'link', userId: 'u1' },
    { personKey: 'b', action: 'create', name: 'Ben Okafor', roleName: 'Sommelier' },
    { personKey: 'c', action: 'skip' },
  ]);
  assert.equal(req.weekStart, '2026-08-31');
  assert.deepEqual(req.addedPeople, [{ name: 'Dara Quinn', roleName: 'Host' }]);
  assert.equal(req.rememberRoleMappings, true);
  assert.deepEqual(req.edits, [{ rowNumber: 2, startTime: '18:30', endTime: '02:00', overnight: true }]);
});

test('result lines name created / matched / duplicates-skipped', () => {
  const lines = importResultLines({ createdPeople: 8, linkedPeople: 2, skippedPeople: 0, createdShifts: 40, skippedDuplicates: 3, overlaps: [] });
  assert.deepEqual(lines, [
    '8 new people added to your staff',
    '2 matched to people already on your staff',
    '40 shifts added',
    '3 shifts were already on the rota — not added twice',
  ]);
});

test('the reader chip says who read the roster in plain words, never the parser\'s internal label', () => {
  const base = { rowsDetected: null, peopleFound: 3, rereadPages: [], disagreements: 0, fromCache: false };
  assert.equal(readerLabel({ ...base, ai: 'not_used', table: 'used' }), "Read from the file's text");
  assert.equal(readerLabel({ ...base, ai: 'used', table: 'used' }), "Read by the AI reader, checked against the file's text");
  assert.equal(readerLabel({ ...base, ai: 'used', table: 'not_applicable', crossChecked: true }), 'Read twice by the AI reader');
  assert.equal(readerLabel({ ...base, ai: 'cached', table: 'not_applicable' }), 'Read by the AI reader');
  assert.equal(readerLabel(undefined), null);
});

test('a photo page nothing was imported from is announced, with the reading\'s own words and the pages; otherwise no notice', () => {
  const base = { ai: 'used' as const, table: 'not_applicable' as const, rowsDetected: null, peopleFound: 0, rereadPages: [], disagreements: 0, fromCache: false, crossChecked: true };
  assert.equal(hardToReadNotice({ ...base, note: 'Read twice.' }), null);
  assert.equal(hardToReadNotice(undefined), null);
  const notice = hardToReadNotice({ ...base, note: 'This photo was hard to read — so nothing from it was imported. Upload the original PDF.', withheldPages: [{ page: 1, reason: 'Page 1 was hard to read.' }] });
  assert.deepEqual(notice, { text: 'This photo was hard to read — so nothing from it was imported. Upload the original PDF.', pages: [1] });
  assert.match(hardToReadNotice({ ...base, withheldPages: [{ page: 2, reason: 'x' }] })!.text, /upload the original PDF or spreadsheet/);
});
