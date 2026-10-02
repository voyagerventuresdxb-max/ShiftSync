import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { createOrgShell, grantPlatformAdmin } from './adminActions.js';
import { peekLoginLink, redeemLoginLink } from './loginLinkActions.js';
import { DEFAULT_ROLES } from '../../../../shared/defaultRoles.js';

const prisma = new PrismaClient();
const TAG = '__admin-actions-test__';
const phone = () => `+97150${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`;

after(async () => {
  await prisma.organization.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.$disconnect();
});

test('createOrgShell: org + location + OWNER + default roles + a working first login link whose landing is the Venue step', async () => {
  const ownerPhone = phone();
  const { organization, location, owner, link } = await createOrgShell({ venueName: `${TAG} Pilot Venue`, ownerFullName: 'Pilot GM', ownerPhone });
  assert.equal(location.organizationId, organization.id);
  assert.equal(owner.systemRole, 'OWNER');
  assert.equal(owner.phone, ownerPhone);
  assert.equal(await prisma.role.count({ where: { locationId: location.id } }), DEFAULT_ROLES.length);
  assert.match(link.url, /\/login\/link#[A-Za-z0-9_-]{43}$/);
  const row = await prisma.loginLink.findUniqueOrThrow({ where: { id: link.id } });
  assert.equal(row.issuedById, null, 'CLI-minted links have no issuer');

  const token = link.url.slice(link.url.indexOf('#') + 1);
  const peek = await peekLoginLink(token);
  assert.equal(peek.result, 'ok');
  const redeemed = await redeemLoginLink(token, { ip: '127.0.0.1', userAgent: 'test' });
  assert.equal(redeemed.result, 'ok');
  if (redeemed.result === 'ok') {
    assert.equal(redeemed.user.id, owner.id);
    assert.equal(redeemed.landing, '/onboarding/venue');
  }
});

test('createOrgShell stores the owner phone in E.164 and refuses a taken (even deactivated), invalid or blank one', async () => {
  const ownerPhone = phone();
  const local = `0${ownerPhone.slice(4)}`; // 050XXXXXXX — same number, local format
  const { owner } = await createOrgShell({ venueName: `${TAG} First`, ownerFullName: 'First Owner', ownerPhone: local });
  assert.equal(owner.phone, ownerPhone, 'stored as E.164');
  await assert.rejects(() => createOrgShell({ venueName: `${TAG} Second`, ownerFullName: 'Second Owner', ownerPhone }), /already has the phone/);
  await prisma.user.update({ where: { id: owner.id }, data: { isActive: false } });
  await assert.rejects(() => createOrgShell({ venueName: `${TAG} Third`, ownerFullName: 'Third Owner', ownerPhone }), /already has the phone/, 'User.phone is unique across deactivated users too');
  await assert.rejects(() => createOrgShell({ venueName: `${TAG} Bad`, ownerFullName: 'X', ownerPhone: '12345' }), /valid mobile number/);
  await assert.rejects(() => createOrgShell({ venueName: '  ', ownerFullName: 'X', ownerPhone: phone() }), /venueName/);
});

test('grantPlatformAdmin: by phone in any format; unknown, deactivated or invalid phones are refused', async () => {
  const ownerPhone = phone(); // +97150XXXXXXX
  const { owner } = await createOrgShell({ venueName: `${TAG} Admin Venue`, ownerFullName: 'Future Admin', ownerPhone });
  assert.equal(owner.isPlatformAdmin, false);
  const local = `0${ownerPhone.slice(4)}`; // 050XXXXXXX — same number, local format
  const granted = await grantPlatformAdmin(local);
  assert.equal(granted.id, owner.id);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).isPlatformAdmin, true);
  await assert.rejects(() => grantPlatformAdmin('+971500000000'), /No active user/);
  await assert.rejects(() => grantPlatformAdmin('not a phone'), /valid mobile number/);

  const leaverPhone = phone();
  const { owner: leaver } = await createOrgShell({ venueName: `${TAG} Leaver Venue`, ownerFullName: 'Leaver', ownerPhone: leaverPhone });
  await prisma.user.update({ where: { id: leaver.id }, data: { isActive: false } });
  await assert.rejects(() => grantPlatformAdmin(leaverPhone), /No active user/);
});
