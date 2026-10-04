import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingSmsSettings, otpSmsBody, sendOtpSms, smsOtpEnabled, twilioSender, type SmsSender } from './sms.js';

// Fake, obviously non-functional settings: these tests never reach a network.
const CONFIGURED = { SMS_OTP_ENABLED: 'true', TWILIO_ACCOUNT_SID: 'ACfake-test-sid', TWILIO_AUTH_TOKEN: 'fake-test-token', SMS_SENDER_ID: 'ShiftSync' };
/** A random valid-shaped UAE mobile in E.164, generated per run. */
const phone = () => `+97150${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: () => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function captureErrors<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  return fn()
    .then((result) => ({ result, lines }))
    .finally(() => {
      console.error = original;
    });
}

test('SMS_OTP_ENABLED is on only for exactly "true"; off is the default', () => {
  assert.equal(smsOtpEnabled({}), false);
  for (const value of ['false', '1', 'TRUE', 'yes', '']) assert.equal(smsOtpEnabled({ SMS_OTP_ENABLED: value }), false, value);
  assert.equal(smsOtpEnabled({ SMS_OTP_ENABLED: 'true' }), true);
});

test('flag off: nothing is sent and the route carries on as before', async () => {
  let sends = 0;
  const sender: SmsSender = { send: async () => (sends++, { ok: true }) };
  assert.equal(await sendOtpSms(phone(), '123456', 'test', { ...CONFIGURED, SMS_OTP_ENABLED: undefined }, sender), 'off');
  assert.equal(sends, 0);
});

test('flag on: the code goes out in a body with no link and no phone number', async () => {
  const sent: { to: string; body: string }[] = [];
  const sender: SmsSender = { send: async (to, body) => (sent.push({ to, body }), { ok: true }) };
  const to = phone();
  assert.equal(await sendOtpSms(to, '482913', 'test', CONFIGURED, sender), 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, to);
  assert.equal(sent[0]!.body, otpSmsBody('482913'));
  assert.match(sent[0]!.body, /^482913 /);
  assert.doesNotMatch(sent[0]!.body, /https?:|www\.|\+\d|\d{7,}/);
});

test('a failed send is reported as failed and the log line names neither the number nor the code', async () => {
  const to = phone();
  const sender: SmsSender = { send: async () => ({ ok: false, reason: 'rejected', status: 400, providerCode: 21211 }) };
  const { result, lines } = await captureErrors(() => sendOtpSms(to, '482913', 'test', CONFIGURED, sender));
  assert.equal(result, 'failed');
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /rejected \(HTTP 400, provider code 21211\)/);
  assert.ok(!lines[0]!.includes(to.slice(4)) && !lines[0]!.includes('482913'));
});

test('missingSmsSettings names what is unset (never values); a sender ID or a messaging service will do', () => {
  assert.deepEqual(missingSmsSettings(CONFIGURED), []);
  assert.deepEqual(missingSmsSettings({ ...CONFIGURED, SMS_SENDER_ID: undefined, TWILIO_MESSAGING_SERVICE_SID: 'MGfake' }), []);
  assert.deepEqual(missingSmsSettings({ SMS_OTP_ENABLED: 'true', TWILIO_AUTH_TOKEN: ' ' }), [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_MESSAGING_SERVICE_SID or SMS_SENDER_ID',
  ]);
});

test('twilioSender: unconfigured → not_configured, without any request', async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response('{}', { status: 201 }));
  assert.deepEqual(await twilioSender({ SMS_OTP_ENABLED: 'true' }, fetchImpl).send(phone(), 'x'), { ok: false, reason: 'not_configured' });
  assert.equal(calls.length, 0);
});

test('twilioSender posts one form-encoded Messages request with Basic auth, from the sender ID', async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response(JSON.stringify({ sid: 'SMfake' }), { status: 201 }));
  const to = phone();
  assert.deepEqual(await twilioSender(CONFIGURED, fetchImpl).send(to, 'hello'), { ok: true });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0]!;
  assert.equal(url, 'https://api.twilio.com/2010-04-01/Accounts/ACfake-test-sid/Messages.json');
  assert.equal(init.method, 'POST');
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Basic ${Buffer.from('ACfake-test-sid:fake-test-token').toString('base64')}`);
  assert.equal(headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(String(init.body));
  assert.deepEqual(Object.fromEntries(form), { To: to, Body: 'hello', From: 'ShiftSync' });
  assert.ok(init.signal, 'the request has a timeout');
});

test('twilioSender prefers the Messaging Service when one is set', async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response('{}', { status: 201 }));
  await twilioSender({ ...CONFIGURED, TWILIO_MESSAGING_SERVICE_SID: 'MGfake' }, fetchImpl).send(phone(), 'hello');
  const form = new URLSearchParams(String(calls[0]!.init.body));
  assert.equal(form.get('MessagingServiceSid'), 'MGfake');
  assert.equal(form.get('From'), null);
});

test('twilioSender: 4xx → rejected (with the provider code), 429/5xx/network → unavailable', async () => {
  const cases: [() => Response | Promise<Response>, object][] = [
    [() => new Response(JSON.stringify({ code: 21211, message: 'quotes the number' }), { status: 400 }), { ok: false, reason: 'rejected', status: 400, providerCode: 21211 }],
    [() => new Response('not json', { status: 401 }), { ok: false, reason: 'rejected', status: 401, providerCode: undefined }],
    [() => new Response('{}', { status: 429 }), { ok: false, reason: 'unavailable', status: 429, providerCode: undefined }],
    [() => new Response('{}', { status: 503 }), { ok: false, reason: 'unavailable', status: 503, providerCode: undefined }],
    [() => Promise.reject(new TypeError('fetch failed')), { ok: false, reason: 'unavailable' }],
  ];
  for (const [respond, expected] of cases) {
    const { fetchImpl } = fakeFetch(respond);
    assert.deepEqual(await twilioSender(CONFIGURED, fetchImpl).send(phone(), 'hello'), expected);
  }
});
