import { test, expect } from '@playwright/test';
import { cleanupTestOrgs, nextEchoPhone, prisma, testVenueName } from './helpers';

/**
 * Push, mocked at the boundary: the e2e API runs with PUSH_TRANSPORT=record (playwright.config.ts),
 * so every send lands in GET /api/dev/push-outbox instead of a push service. No VAPID keys, push
 * service or push sink are needed; everything up to the send — who gets notified, with what — is
 * the real code. Specs that need a "device" give the user a PushSubscription row.
 */
const API = 'http://localhost:4000';
const usedPhones: string[] = [];

test.afterEach(async () => {
  await cleanupTestOrgs();
  await prisma.otpCode.deleteMany({ where: { phone: { in: usedPhones.splice(0) } } });
});

test('an announcement reaches each subscribed staff device as a recorded push — no VAPID keys involved', async ({ request }) => {
  const org = await prisma.organization.create({ data: { name: testVenueName('push-outbox') } });
  const location = await prisma.location.create({ data: { organizationId: org.id, name: org.name } });
  const ownerPhone = nextEchoPhone();
  usedPhones.push(ownerPhone);
  await prisma.user.create({ data: { locationId: location.id, systemRole: 'OWNER', fullName: 'E2E Push Owner', phone: ownerPhone } });
  const staff = await prisma.user.create({ data: { locationId: location.id, systemRole: 'STAFF', fullName: 'E2E Push Staff' } });
  await prisma.pushSubscription.create({ data: { userId: staff.id, endpoint: `https://push.invalid/${staff.id}`, p256dh: 'test-key', auth: 'test-auth' } });

  const otp = await (await request.post(`${API}/api/identity/request-otp`, { data: { phone: ownerPhone } })).json();
  const { token } = await (await request.post(`${API}/api/identity/verify-otp`, { data: { phone: ownerPhone, code: otp.devCode } })).json();
  const posted = await request.post(`${API}/api/announcements`, { headers: { Authorization: `Bearer ${token}` }, data: { body: 'E2E push outbox check' } });
  expect(posted.status()).toBe(201);

  await expect
    .poll(async () => (await (await request.get(`${API}/api/dev/push-outbox?userId=${staff.id}`)).json()).sent, { timeout: 10_000 })
    .toEqual([expect.objectContaining({ userId: staff.id, endpoint: `https://push.invalid/${staff.id}`, payload: { title: 'New announcement', body: 'E2E push outbox check', url: '/' } })]);

  // The in-app notification is written as well (the bell), exactly as with real push.
  expect(await prisma.notification.count({ where: { userId: staff.id, title: 'New announcement' } })).toBe(1);
});
