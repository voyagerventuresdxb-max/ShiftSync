import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { buildCleanupPlan, executeCleanupPlan, formatPlan, isTestOrgName } from './testVenueCleanup.js';

const prisma = new PrismaClient();
const RUN = randomUUID().slice(0, 8);
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'server', 'scripts', 'cleanup-test-venues.ts');
const tail = () => String(Math.floor(1_000_000 + Math.random() * 8_999_999));
const mobile = () => `+97150${tail()}`;

const tmpRoot = await mkdtemp(join(tmpdir(), 'shiftsync-cleanup-it-'));
const uploadsDir = join(tmpRoot, 'uploads');
await mkdir(join(uploadsDir, 'floor-plans'), { recursive: true });
await mkdir(join(uploadsDir, 'policy-documents'), { recursive: true });

/** An uploaded file on disk plus the fileUrl the app would store for it. */
async function upload(dir: 'floor-plans' | 'policy-documents', ext: string, onDisk = true) {
  const name = `${randomUUID()}.${ext}`;
  if (onDisk) await writeFile(join(uploadsDir, dir, name), 'x');
  return { fileUrl: `/uploads/${dir}/${name}`, path: join(uploadsDir, dir, name) };
}

async function venue(orgName: string) {
  const org = await prisma.organization.create({ data: { name: orgName } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: `${orgName} venue` } });
  const role = await prisma.role.create({ data: { locationId: location.id, name: 'Waiter' } });
  return { org, location, role };
}

const user = (locationId: string, fullName: string, phone: string | null, systemRole: 'OWNER' | 'STAFF' = 'STAFF') =>
  prisma.user.create({ data: { locationId, fullName, phone, systemRole } });

const otp = (phone: string) =>
  prisma.otpCode.create({ data: { phone, codeHash: 'x', purpose: 'LOGIN', expiresAt: new Date(Date.now() + 600_000) } });

// --- A real-looking venue that must survive everything below.
const real = await venue(`Cleanup IT Real Venue ${RUN}`);
const realPhoneTail = tail();
const realUser = await user(real.location.id, 'Real Manager', `+97150${realPhoneTail}`, 'OWNER');
const realPlan = await upload('floor-plans', 'png');
await prisma.floorPlanImage.create({ data: { locationId: real.location.id, fileUrl: realPlan.fileUrl, mimeType: 'image/png' } });

// --- Test org A: an e2e venue with a shift (shifts.role_id is RESTRICT), a floor plan, sections, sessions, OTPs.
const a = await venue(`__e2e-test__ cleanup-it ${RUN} A`);
const aOwner = await user(a.location.id, 'A Owner', mobile(), 'OWNER');
const aStaff = await user(a.location.id, 'A Staff', mobile());
const aPlan = await upload('floor-plans', 'png');
const aImage = await prisma.floorPlanImage.create({ data: { locationId: a.location.id, fileUrl: aPlan.fileUrl, mimeType: 'image/png' } });
// A tampered fileUrl pointing outside the uploads dir, with a real file there: must never be touched.
const outsideFile = join(tmpRoot, `outside-${RUN}.txt`);
await writeFile(outsideFile, 'keep me');
await prisma.floorPlanImage.create({ data: { locationId: a.location.id, fileUrl: `/uploads/floor-plans/../../outside-${RUN}.txt`, mimeType: 'text/plain' } });
const aSection = await prisma.floorSection.create({ data: { locationId: a.location.id, floorPlanImageId: aImage.id, label: 'Terrace', paxCapacity: 10 } });
await prisma.sectionAssignment.create({ data: { sectionId: aSection.id, staffId: aStaff.id, shiftDate: new Date('2026-10-02') } });
await prisma.shift.create({
  data: { locationId: a.location.id, roleId: a.role.id, userId: aStaff.id, date: new Date('2026-10-02'), startTime: new Date('2026-10-02T14:00:00Z'), endTime: new Date('2026-10-02T22:00:00Z') },
});
await prisma.session.create({ data: { userId: aOwner.id, tokenHash: `cleanup-it-${randomUUID()}`, expiresAt: new Date(Date.now() + 3_600_000) } });
await otp(aOwner.phone!);
await otp(aOwner.phone!);
// A's staff phone is also applying to the real venue: its OTP rows belong to that live application and stay.
await prisma.joinRequest.create({ data: { locationId: real.location.id, phone: aStaff.phone!, fullName: 'Applicant' } });
await otp(aStaff.phone!);

// --- Test org B: the #53 shape — one manager, a floor plan whose file is already gone, plus a policy document.
const b = await venue(`__deploy-check__ cleanup-it ${RUN} B`);
// Stored in the pre-E.164 format; its E.164 form is the real user's phone, so that number's OTP rows stay.
const bOwner = await user(b.location.id, 'B Manager', `050 ${realPhoneTail}`, 'OWNER');
const bLostPlan = await upload('floor-plans', 'png', false);
await prisma.floorPlanImage.create({ data: { locationId: b.location.id, fileUrl: bLostPlan.fileUrl, mimeType: 'image/png' } });
const bDoc = await upload('policy-documents', 'pdf');
await prisma.policyDocument.create({ data: { locationId: b.location.id, category: 'Safety', title: 'Fire', fileUrl: bDoc.fileUrl, mimeType: 'application/pdf', uploadedById: bOwner.id } });
await otp(realUser.phone!);

// --- Test org C: its staff member has a shoutout in the real venue, so deleting C would cascade into the real venue.
const c = await venue(`__e2e-test__ cleanup-it ${RUN} C`);
const cStaff = await user(c.location.id, 'C Staff', mobile());
const crossShoutout = await prisma.shoutout.create({ data: { locationId: real.location.id, employeeId: cStaff.id, note: 'great shift' } });

// --- Near misses: none of these may ever match.
const nearMisses = await Promise.all(
  [` __deploy-check__ cleanup-it ${RUN}`, `x__e2e-test__ cleanup-it ${RUN}`, `ZZe2e-test__ cleanup-it ${RUN}`, `__E2E-TEST__ cleanup-it ${RUN}`].map((name) =>
    prisma.organization.create({ data: { name } }),
  ),
);

const ownTestOrgIds = new Set([a.org.id, b.org.id, c.org.id]);
const survivorOrgIds = [real.org.id, ...nearMisses.map((o) => o.id)];
const allPhones = [aOwner.phone!, aStaff.phone!, realUser.phone!, cStaff.phone!, bOwner.phone!];

after(async () => {
  const leftovers = [...survivorOrgIds, ...ownTestOrgIds];
  await prisma.shift.deleteMany({ where: { location: { organizationId: { in: leftovers } } } });
  await prisma.organization.deleteMany({ where: { id: { in: leftovers } } });
  await prisma.otpCode.deleteMany({ where: { phone: { in: allPhones } } });
  await rm(tmpRoot, { recursive: true, force: true });
  await prisma.$disconnect();
});

const orgCount = (ids: string[]) => prisma.organization.count({ where: { id: { in: ids } } });
const otpCount = (phone: string) => prisma.otpCode.count({ where: { phone } });

test('dry run lists exactly the test orgs (counts, files, OTP phones, cross-venue block) and deletes nothing', async () => {
  const plan = await buildCleanupPlan(prisma, { uploadsDir });
  const ids = new Set(plan.orgs.map((o) => o.id));
  for (const org of plan.orgs) assert.ok(isTestOrgName(org.name), `only test-prefixed orgs are listed: ${org.name}`);
  for (const id of ownTestOrgIds) assert.ok(ids.has(id));
  for (const id of survivorOrgIds) assert.ok(!ids.has(id), 'the real venue and every near miss are never listed');

  const planA = plan.orgs.find((o) => o.id === a.org.id)!;
  assert.equal(planA.users.length, 2);
  assert.deepEqual(
    Object.fromEntries(Object.entries(planA.counts).filter(([, n]) => n > 0)),
    { organizations: 1, locations: 1, users: 2, roles: 1, shifts: 1, floor_plan_images: 2, floor_sections: 1, section_assignments: 1, sessions: 1, otp_codes: 2 },
  );
  assert.deepEqual(planA.scope.otpPhones, [aOwner.phone], "the staff phone's OTP rows stay: another venue has its join request");
  assert.deepEqual(
    [...planA.files].sort((x, y) => x.fileUrl.localeCompare(y.fileUrl)),
    [
      { fileUrl: `/uploads/floor-plans/../../outside-${RUN}.txt`, path: null, exists: false },
      { fileUrl: aPlan.fileUrl, path: aPlan.path, exists: true },
    ].sort((x, y) => x.fileUrl.localeCompare(y.fileUrl)),
  );
  assert.deepEqual(planA.blockedBy, []);

  const planB = plan.orgs.find((o) => o.id === b.org.id)!;
  assert.ok(!planB.scope.otpPhones.includes(realUser.phone!), "never the OTP rows of a phone a surviving user holds");
  assert.equal(planB.counts.otp_codes, 0);
  assert.deepEqual(
    planB.files.map((f) => [f.path, f.exists]),
    [
      [bLostPlan.path, false],
      [bDoc.path, true],
    ],
    'floor plans, then policy documents',
  );

  const planC = plan.orgs.find((o) => o.id === c.org.id)!;
  assert.equal(planC.blockedBy.length, 1);
  assert.match(planC.blockedBy[0]!, /1 shoutouts row\(s\) in other venues/);

  const text = formatPlan({ ...plan, orgs: plan.orgs.filter((o) => ownTestOrgIds.has(o.id)) }, 'localhost', false);
  assert.match(text, /DRY RUN, nothing will be deleted/);
  assert.ok(text.includes(a.org.name) && text.includes(b.org.name));
  assert.ok(!text.includes(real.org.name));
  assert.ok(!text.includes(aOwner.phone!), 'phones are redacted');
  assert.ok(text.includes(`${aOwner.phone!.slice(0, 4)}*******${aOwner.phone!.slice(-2)}`));
  assert.match(text, /BLOCKED, will not be deleted/);

  const exact = await buildCleanupPlan(prisma, { uploadsDir, name: b.org.name });
  assert.deepEqual(exact.orgs.map((o) => o.id), [b.org.id], '--name targets exactly one org');
  assert.deepEqual((await buildCleanupPlan(prisma, { uploadsDir, name: real.org.name })).orgs, [], '--name never reaches a non-test org');

  assert.equal(await orgCount([...ownTestOrgIds]), 3, 'nothing deleted');
  assert.ok(existsSync(aPlan.path) && existsSync(bDoc.path));
  assert.equal(await otpCount(aOwner.phone!), 2);
});

test('the CLI (no flags) is a dry run end to end: lists the test orgs, never the real one, deletes nothing', () => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT], { cwd: REPO_ROOT, env: process.env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /DRY RUN, nothing will be deleted/);
  assert.ok(run.stdout.includes(a.org.name) && run.stdout.includes(b.org.name) && run.stdout.includes(c.org.name));
  assert.ok(!run.stdout.includes(real.org.name));
  for (const near of nearMisses) assert.ok(!run.stdout.includes(near.id), near.name);
});

test('--confirm deletes exactly the test orgs, their rows, files and OTPs in one transaction each; the real venue is untouched', async () => {
  assert.equal(await orgCount([...ownTestOrgIds]), 3, 'the dry runs deleted nothing');
  const plan = await buildCleanupPlan(prisma, { uploadsDir });
  // Only this file's orgs: other server test files running in parallel on this schema own the other matches.
  const results = await executeCleanupPlan(prisma, { ...plan, orgs: plan.orgs.filter((o) => ownTestOrgIds.has(o.id)) });
  const byId = new Map(results.map((r) => [r.org.id, r]));

  for (const org of [a.org, b.org]) {
    const r = byId.get(org.id)!;
    assert.equal(r.deleted, true, r.error ?? '');
    assert.ok(Object.values(r.after!).every((n) => n === 0), JSON.stringify(r.after));
  }
  assert.equal(await orgCount([a.org.id, b.org.id]), 0);
  assert.equal(await prisma.user.count({ where: { id: { in: [aOwner.id, aStaff.id, bOwner.id] } } }), 0);
  assert.equal(await prisma.shift.count({ where: { locationId: a.location.id } }), 0);

  assert.deepEqual(byId.get(a.org.id)!.files, [{ path: aPlan.path, outcome: 'deleted' }]);
  assert.deepEqual(byId.get(b.org.id)!.files, [
    { path: bLostPlan.path, outcome: 'already missing' },
    { path: bDoc.path, outcome: 'deleted' },
  ]);
  assert.ok(!existsSync(aPlan.path) && !existsSync(bDoc.path));
  assert.ok(existsSync(outsideFile), 'a file outside the uploads dir is never deleted');

  assert.equal(await otpCount(aOwner.phone!), 0);
  assert.equal(await otpCount(aStaff.phone!), 1, 'kept: a live join request elsewhere');
  assert.equal(await otpCount(realUser.phone!), 1, "kept: the real user's phone");

  const blocked = byId.get(c.org.id)!;
  assert.equal(blocked.deleted, false);
  assert.match(blocked.error!, /^skipped: /);
  assert.equal(await orgCount([c.org.id]), 1);
  assert.equal(await prisma.shoutout.count({ where: { id: crossShoutout.id } }), 1);

  assert.equal(await orgCount(survivorOrgIds), survivorOrgIds.length, 'the real venue and the near misses survive');
  assert.equal(await prisma.user.count({ where: { id: realUser.id } }), 1);
  assert.equal(await prisma.floorPlanImage.count({ where: { locationId: real.location.id } }), 1);
  assert.equal(await prisma.joinRequest.count({ where: { locationId: real.location.id } }), 1);
  assert.ok(existsSync(realPlan.path), "the real venue's floor plan file is untouched");
});
