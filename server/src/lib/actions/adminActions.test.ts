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

test('createOrgShell refuses a phone that already belongs to an active user, and blank inputs', async () => {
  const ownerPhone = phone();
  await createOrgShell({ venueName: `${TAG} First`, ownerFullName: 'First Owner', ownerPhone });
  await assert.rejects(() => createOrgShell({ venueName: `${TAG} Second`, ownerFullName: 'Second Owner', ownerPhone }), /already has the phone/);
  await assert.rejects(() => createOrgShell({ venueName: '  ', ownerFullName: 'X', ownerPhone: phone() }), /venueName/);
});

test('grantPlatformAdmin: by phone in any format; unknown or ambiguous phones are refused', async () => {
  const ownerPhone = phone(); // +97150XXXXXXX
  const { owner } = await createOrgShell({ venueName: `${TAG} Admin Venue`, ownerFullName: 'Future Admin', ownerPhone });
  assert.equal(owner.isPlatformAdmin, false);
  const local = `0${ownerPhone.slice(4)}`; // 050XXXXXXX — same number, local format
  const granted = await grantPlatformAdmin(local);
  assert.equal(granted.id, owner.id);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).isPlatformAdmin, true);
  await assert.rejects(() => grantPlatformAdmin('+971500000000'), /No active user/);
});
