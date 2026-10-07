import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editDistance, foldName, phoneticKey, resolvePerson, type PersonResolution, type StaffEntry } from './people.js';

// Made-up venue: shared first names (two Omars, three Karims), transliterated spellings, short forms.
const staff: StaffEntry[] = [
  { id: 'caller', fullName: 'Dina Manager', role: 'Manager' },
  { id: 'omarH', fullName: 'Omar Haddad', role: 'Bartender' },
  { id: 'omarF', fullName: 'Omar Farouk', role: 'Waiter' },
  { id: 'karimS', fullName: 'Karim Saleh', role: 'Chef' },
  { id: 'karimA', fullName: 'Karim Aziz', role: 'Runner' },
  { id: 'karimB', fullName: 'Karim Bashir', role: 'Host' },
  { id: 'muhammadQ', fullName: 'Muhammad Qasim', role: 'Barback' },
  { id: 'michael', fullName: 'Michael Tanaka', role: 'Sommelier' },
  { id: 'riya', fullName: 'Riya Desai', role: 'Waiter' },
  { id: 'riaz', fullName: 'Riaz Malik', role: 'Runner' },
  { id: 'phillipa', fullName: 'Phillipa Okafor', role: 'Host' },
  { id: 'samuel', fullName: 'Samuel Brandt', role: 'Chef' },
  { id: 'samantha', fullName: 'Samantha Quill', role: 'Waiter' },
  { id: 'junjun', fullName: 'Jun-Jun Ramos', role: 'Runner' },
];
const say = (heard: string, modelId: string | null = null, list = staff) => resolvePerson(heard, modelId, list, `Give ${heard} a shout-out`, 'caller');
const ids = (r: PersonResolution) =>
  r.kind === 'one' ? [r.person.id] : r.kind === 'ambiguous' ? r.people.map((p) => p.id) : r.kind === 'missing' ? r.near.map((p) => p.id) : [];
const one = (r: PersonResolution) => (r.kind === 'one' ? r.person.id : null);

test('building blocks: spelling fold, phonetic key, edit distance', () => {
  assert.equal(foldName('Mohammed'), foldName('Muhammad'));
  assert.equal(foldName('Mohd'), 'muhammad');
  assert.equal(foldName('Phillip'), foldName('Filip'));
  assert.equal(foldName('Khalid'), foldName('Kalid'));
  assert.equal(foldName('Jennie'), foldName('Jenny'));
  assert.equal(foldName('Kareem'), foldName('Karim'));
  assert.equal(phoneticKey('Riya'), phoneticKey('Rhea'));
  assert.notEqual(phoneticKey('Riya'), phoneticKey('Riaz'));
  assert.equal(editDistance('omar', 'omra'), 1);
  assert.equal(editDistance('karim', 'karin'), 1);
});

test('exact full name, exact unique first name and surname resolve to that one person', () => {
  assert.equal(one(say('Omar Farouk')), 'omarF');
  assert.equal(one(say('omar haddad')), 'omarH');
  assert.equal(one(say('Michael')), 'michael');
  assert.equal(one(say('Tanaka')), 'michael');
  assert.equal(one(say('Desai')), 'riya');
});

test('a first name two people share is a Which-one choice with both, roles attached', () => {
  const r = say('Omar', 'omarH');
  assert.equal(r.kind, 'ambiguous');
  assert.deepEqual(ids(r), ['omarF', 'omarH']);
  assert.deepEqual(r.kind === 'ambiguous' && r.people.map((p) => p.role), ['Waiter', 'Bartender']);
});

test('a first name three people share offers all three', () => {
  const r = say('Karim');
  assert.deepEqual([r.kind, ids(r)], ['ambiguous', ['karimA', 'karimB', 'karimS']]);
});

test('short forms and transliterated spellings are the same name', () => {
  assert.equal(one(say('Mick')), 'michael');
  assert.equal(one(say('Mohammed')), 'muhammadQ');
  assert.equal(one(say('Mohd Qasim')), 'muhammadQ');
  assert.equal(one(say('Mo')), 'muhammadQ');
  assert.equal(one(say('Filippa')), 'phillipa');
  assert.equal(one(say('Junjun')), 'junjun');
  // "Sam" could be Samuel or Samantha: asked, never picked.
  assert.deepEqual([say('Sam').kind, ids(say('Sam'))], ['ambiguous', ['samantha', 'samuel']]);
});

test('two spellings of one spoken name on the same team are a question, not a tie-break', () => {
  const list = [...staff, { id: 'mohamadA', fullName: 'Mohamad Amin', role: 'Waiter' }];
  const r = say('Mohammed', null, list);
  assert.deepEqual([r.kind, ids(r)], ['ambiguous', ['mohamadA', 'muhammadQ']]);
});

test('phonetic mishearings: one clear sound-alike resolves; a near miss or two candidates is a question', () => {
  // Vowel swap / doubled letter of a unique name.
  assert.equal(one(say('Michel')), 'michael');
  assert.equal(one(say('Tannaka')), 'michael');
  // Dropped letter of a shared first name: still both Omars, never one.
  assert.notEqual(say('Omr').kind, 'one');
  // Riya and Riaz both exist, a letter apart: even the exact name is asked, that name first.
  assert.deepEqual([say('Riya').kind, ids(say('Riya'))], ['ambiguous', ['riya', 'riaz']]);
  assert.deepEqual([say('Riaz').kind, ids(say('Riaz'))], ['ambiguous', ['riaz', 'riya']]);
  // Their full names settle.
  assert.equal(one(say('Riya Desai')), 'riya');
  // "Ria" spells Riya but is one letter from Riaz: asked, with both.
  assert.deepEqual([say('Ria').kind, ids(say('Ria'))], ['ambiguous', ['riya', 'riaz']]);
  assert.deepEqual([say('Rias').kind, ids(say('Rias')).sort()], ['missing', ['riaz', 'riya']]);
  // Only Riaz on the team: "Riya" is close but does not sound the same, so it is a did-you-mean.
  const noRiya = staff.filter((p) => p.id !== 'riya');
  const r = say('Riya', null, noRiya);
  assert.deepEqual([r.kind, ids(r)], ['missing', ['riaz']]);
});

test('a short form two listed first names share is asked, never picked ("Dan": Daniel and Daniela; "Alex": Alexander and Alexandra)', () => {
  const list: StaffEntry[] = [
    { id: 'daniel', fullName: 'Daniel Lane', role: 'Chef' },
    { id: 'daniela', fullName: 'Daniela Silva', role: 'Waiter' },
    { id: 'alexander', fullName: 'Alexander Petrov', role: 'Host' },
    { id: 'alexandra', fullName: 'Alexandra Kim', role: 'Bartender' },
  ];
  for (const heard of ['Dan', 'Danny']) {
    const r = say(heard, null, list);
    assert.notEqual(r.kind, 'one', heard);
    assert.ok(ids(r).includes('daniel') && ids(r).includes('daniela'), `${heard}: ${ids(r)}`);
  }
  const alex = say('Alex', null, list);
  assert.deepEqual([alex.kind, ids(alex).sort()], ['ambiguous', ['alexander', 'alexandra']]);
});

test('a short form of one person, with someone else of a similar name, is asked: the short form never loses to a prefix, and never wins alone', () => {
  const list: StaffEntry[] = [
    { id: 'james', fullName: 'James Tanaka', role: 'Sommelier' },
    { id: 'jimi', fullName: 'Jimi Arana', role: 'Runner' },
    { id: 'nathaniel', fullName: 'Nathaniel Ruiz', role: 'Chef' },
    { id: 'nata', fullName: 'Nata Moreau', role: 'Host' },
    { id: 'thomas', fullName: 'Thomas Reid', role: 'Waiter' },
    { id: 'tomi', fullName: 'Tomi Varga', role: 'Barback' },
  ];
  const jim = say('Jim', null, list);
  assert.equal(jim.kind, 'ambiguous');
  assert.deepEqual(ids(jim).slice(0, 2), ['james', 'jimi'], 'the table short form first');
  const nate = say('Nate', null, list);
  assert.notEqual(nate.kind, 'one');
  assert.deepEqual(ids(nate).sort(), ['nata', 'nathaniel']);
  const tom = say('Tom', null, list);
  assert.notEqual(tom.kind, 'one');
  assert.deepEqual(ids(tom).sort(), ['thomas', 'tomi']);
  // With no one else close, the short form settles.
  assert.equal(one(say('Jim', null, list.filter((p) => p.id !== 'jimi'))), 'james');
});

test('a misspelling with a near neighbour is asked; only an unmistakable one settles', () => {
  const list: StaffEntry[] = [
    { id: 'ramesh', fullName: 'Ramesh Iyer', role: 'Chef' },
    { id: 'rakesh', fullName: 'Rakesh Nair', role: 'Waiter' },
    { id: 'danielle', fullName: 'Danielle Fox', role: 'Host' },
    { id: 'daniela', fullName: 'Daniela Ortiz', role: 'Runner' },
    { id: 'gwendolyn', fullName: 'Gwendolyn Shaw', role: 'Bartender' },
  ];
  for (const heard of ['Ramish', 'Rameshh', 'Rakish', 'Danyelle', 'Daniella']) assert.notEqual(say(heard, null, list).kind, 'one', heard);
  assert.deepEqual(ids(say('Ramish', null, list)).sort(), ['rakesh', 'ramesh']);
  // Five letters or more, one letter off, and nobody else anywhere close: settled.
  assert.equal(one(say('Gwendolin', null, list)), 'gwendolyn');
  // Short words are never settled on spelling alone, but the model picking the same person is.
  const short: StaffEntry[] = [{ id: 'omar', fullName: 'Omar Haddad', role: 'Bartender' }, { id: 'zed', fullName: 'Zed Quinn', role: 'Host' }];
  assert.equal(say('Omer', null, short).kind, 'missing');
  assert.equal(one(say('Omer', 'omar', short)), 'omar');
});

test('an exact one-word name with a close alternative is asked, exact match first ("Edwin"/"Edwina", "Jim"/James, "Dan"/"Dana")', () => {
  const list: StaffEntry[] = [
    { id: 'edwin', fullName: 'Edwin', role: 'Chef' },
    { id: 'edwina', fullName: 'Edwina', role: 'Waiter' },
    { id: 'jim', fullName: 'Jim Brandt', role: 'Host' },
    { id: 'james', fullName: 'James Costa', role: 'Runner' },
    { id: 'dan', fullName: 'Dan Okoye', role: 'Barback' },
    { id: 'dana', fullName: 'Dana Pruitt', role: 'Bartender' },
    { id: 'gwen', fullName: 'Gwen Ito', role: 'Waiter' },
  ];
  assert.deepEqual([say('Edwin', null, list).kind, ids(say('Edwin', null, list))], ['ambiguous', ['edwin', 'edwina']]);
  assert.deepEqual(ids(say('Edwina', null, list)), ['edwina', 'edwin']);
  assert.deepEqual([say('Jim', null, list).kind, ids(say('Jim', null, list))], ['ambiguous', ['jim', 'james']]);
  assert.deepEqual(ids(say('Dan', null, list)), ['dan', 'dana']);
  // A multi-word full name settles; a one-word name with nobody close settles.
  assert.equal(one(say('Jim Brandt', null, list)), 'jim');
  assert.equal(one(say('Dana Pruitt', null, list)), 'dana');
  assert.equal(one(say('Gwen', null, list)), 'gwen');
});

test('nothing plausible: missing with no suggestions (pick from the team)', () => {
  const r = say('Bartholomew');
  assert.deepEqual([r.kind, ids(r)], ['missing', []]);
});

test("never another venue's staff: an unknown id is ignored, and only the list given is searched", () => {
  const r = say('Zubair', 'other-venue-id');
  assert.deepEqual([r.kind, ids(r)], ['missing', []]);
  const other: StaffEntry[] = [{ id: 'elsewhere', fullName: 'Zubair Noor', role: 'Chef' }];
  assert.equal(one(say('Zubair', null, other)), 'elsewhere');
  assert.equal(say('Zubair', 'elsewhere').kind, 'missing');
});

// ---- Variant sweep: a made-up team of 40 with shared first names. ----
const FIRST = ['Omar', 'Omar', 'Karim', 'Karim', 'Karim', 'Layla', 'Maricel', 'Riya', 'Riaz', 'Joseph', 'Josephine', 'Anil', 'Anita', 'Fatima', 'Fatima', 'Hamza', 'Nadia', 'Nadine', 'Tariq', 'Tarek',
  'Grace', 'Gracia', 'Rohan', 'Rowan', 'Elena', 'Elaine', 'Bilal', 'Bilal', 'Kofi', 'Ama', 'Arjun', 'Arun', 'Sunil', 'Sunita', 'Imran', 'Irfan', 'Lina', 'Lena', 'Yusuf', 'Joel'];
const LAST = ['Haddad', 'Farouk', 'Saleh', 'Aziz', 'Bashir', 'Nasser', 'Dizon', 'Desai', 'Malik', 'Mensah', 'Okoro', 'Pillai', 'Pinto', 'Rahim', 'Sayed', 'Qureshi', 'Fares', 'Gharbi', 'Hamdan', 'Hilal',
  'Ikeda', 'Jara', 'Kapoor', 'Kowalski', 'Lazaro', 'Lindqvist', 'Mirza', 'Noor', 'Owusu', 'Asante', 'Patel', 'Prasad', 'Rao', 'Reddy', 'Shaikh', 'Siddiqui', 'Toma', 'Varga', 'Wahid', 'Zamora'];
const team: StaffEntry[] = FIRST.map((f, i) => ({ id: `p${i}`, fullName: `${f} ${LAST[i]}`, role: i % 2 ? 'Waiter' : 'Bartender' }));

const VOWELS = 'aeiou';
function variants(word: string): string[] {
  const w = word.toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < w.length; i++) {
    if (w.length >= 4) out.add(w.slice(0, i) + w.slice(i + 1)); // dropped letter
    out.add(w.slice(0, i + 1) + w[i] + w.slice(i + 1)); // doubled letter
    if (VOWELS.includes(w[i]!)) for (const v of VOWELS) if (v !== w[i]) out.add(w.slice(0, i) + v + w.slice(i + 1)); // vowel swap
  }
  out.delete(w);
  return [...out];
}
const words = (p: StaffEntry) => p.fullName.toLowerCase().split(' ');
/** A variant that is literally another person's name word (and not this person's) is not a mishearing of this one. */
const isOthersName = (variant: string, person: StaffEntry) =>
  !words(person).some((w) => foldName(w) === foldName(variant)) && team.some((p) => p.id !== person.id && words(p).some((w) => foldName(w) === foldName(variant)));

test('variant sweep over a made-up team of 40: wrong person 0, exact first/full names ≥ 95% correct', () => {
  let exactTotal = 0;
  let exactCorrect = 0;
  let exactAsked = 0;
  let variantTotal = 0;
  let variantResolved = 0;
  const wrong: string[] = [];
  const check = (heard: string, person: StaffEntry) => {
    const r = resolvePerson(heard, null, team, `Give ${heard} a shout-out`, 'none');
    if (r.kind === 'one' && r.person.id !== person.id) wrong.push(`${heard} → ${r.person.fullName} (meant ${person.fullName})`);
    return r;
  };
  for (const person of team) {
    const [first, last] = person.fullName.split(' ') as [string, string];
    const shared = team.filter((p) => foldName(words(p)[0]!) === foldName(first)).length > 1;
    for (const heard of [person.fullName, first]) {
      exactTotal++;
      const r = check(heard, person);
      // Correct: that person, or — for a one-word name another person shares or is close to — a
      // question that lists them first among the same-name people (never someone else instead).
      const ok =
        heard === first
          ? one(r) === person.id || (r.kind === 'ambiguous' && r.people.some((p) => p.id === person.id))
          : one(r) === person.id;
      if (ok) exactCorrect++;
      if (heard === first && !shared && r.kind !== 'one') exactAsked++;
    }
    for (const [word, rest, firstPart] of [[first, last, true], [last, first, false]] as const) {
      for (const v of variants(word)) {
        if (isOthersName(v, person)) continue;
        for (const heard of [v, firstPart ? `${v} ${rest}` : `${rest} ${v}`]) {
          variantTotal++;
          if (one(check(heard, person)) === person.id) variantResolved++;
        }
      }
    }
  }
  assert.deepEqual(wrong, []);
  assert.ok(exactCorrect / exactTotal >= 0.95, `exact ${exactCorrect}/${exactTotal}`);
  console.log(`sweep: exact ${exactCorrect}/${exactTotal} (unshared first names asked because a close name exists: ${exactAsked}); variants ${variantTotal}, resolved to the right person ${variantResolved}, wrong person ${wrong.length}`);
});
