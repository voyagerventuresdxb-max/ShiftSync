#!/usr/bin/env node
/**
 * Local load and abuse smoke test — plain Node, no extra tools:
 *
 *   npm run load:smoke -- --users=20,50
 *
 * Starts its own API on port 4100 (this branch's database schema, sign-in
 * codes echoed only for a generated pool of made-up numbers, push in record
 * mode) and drives N concurrent "venues" through: owner signup, invite link,
 * staff join + approval, roles, shifts, publish, staff sign-in, My Shifts and
 * the venue reads. Then an abuse pass from one client address (code-request
 * spray, wrong codes). Each simulated client gets its own X-Real-IP, which is
 * how the API keys its per-client limits.
 *
 * Checks: limits answer 429 (never 500), no 5xx at all, no unhandled
 * rejection or pool-exhaustion line in the server log, server memory stays
 * bounded, and no response carries another venue's records. Prints p50/p95
 * per endpoint. Refuses to run unless DATABASE_URL points at localhost.
 * Everything it creates is named `__load-smoke__ …` and deleted at the end.
 * Never prints a phone number or code.
 */
import { spawn, execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const PORT = 4100;
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = '__load-smoke__';
const sizes = (process.argv.find((a) => a.startsWith('--users='))?.slice(8) ?? '20,50').split(',').map(Number);

const dbHost = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    return '';
  }
})();
if (!['localhost', '127.0.0.1'].includes(dbHost)) {
  console.error('[load-smoke] DATABASE_URL must point at localhost (run it through `npm run load:smoke`).');
  process.exit(1);
}

// A made-up number pool, all UAE-shaped, generated per run; the API echoes codes only for these.
const runSeed = Date.now() % 1_000_000;
const pool = Array.from({ length: Math.max(...sizes) * 3 * sizes.length + 10 }, (_, i) => `+97158${String((runSeed * 7 + i) % 10_000_000).padStart(7, '0')}`);
let nextPhone = 0;
const phone = () => pool[nextPhone++];

// ---- server ---------------------------------------------------------------------------
const serverLog = [];
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), ALLOW_DEV_OTP_ECHO: 'true', ECHO_ALLOWED_PHONES: pool.join(','), PUSH_TRANSPORT: 'record', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const s of [server.stdout, server.stderr]) s.on('data', (d) => serverLog.push(String(d)));
let serverExited = null;
server.on('exit', (code) => (serverExited = code));

async function waitForHealth() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('API did not become healthy');
}

function rssMb(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: 'utf8' });
      return Number(out.trim()) / 1048576;
    }
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024;
  } catch {
    return NaN;
  }
}

// ---- measuring ------------------------------------------------------------------------
const samples = new Map(); // endpoint -> { ms: number[], statuses: Map<status, count> }
async function call(endpoint, method, path, { body, token, ip, headers } = {}) {
  const started = performance.now();
  let status = 0;
  let json = {};
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(ip ? { 'X-Real-IP': ip } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    status = res.status;
    json = await res.json().catch(() => ({}));
  } catch {
    status = -1; // connection failure
  }
  const s = samples.get(endpoint) ?? { ms: [], statuses: new Map() };
  s.ms.push(performance.now() - started);
  s.statuses.set(status, (s.statuses.get(status) ?? 0) + 1);
  samples.set(endpoint, s);
  return { status, json };
}

const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

// ---- one venue's journey ----------------------------------------------------------------
function nextMonday() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 7);
  return d.toISOString().slice(0, 10);
}
const problems = [];

async function venueJourney(n, round) {
  const ownerIp = `10.${round}.${n}.1`;
  const staffIp = `10.${round}.${n}.2`;
  const ownerPhone = phone();
  const staffPhone = phone();

  const otp = await call('signup.request-otp', 'POST', '/api/signup/request-otp', { body: { phone: ownerPhone }, ip: ownerIp });
  if (otp.status !== 200) return problems.push(`signup.request-otp ${otp.status}`);
  const signed = await call('signup.verify-otp', 'POST', '/api/signup/verify-otp', { body: { phone: ownerPhone, code: otp.json.devCode, fullName: `${TAG} owner ${n}`, venueName: `${TAG} venue ${round}-${n}` }, ip: ownerIp });
  if (signed.status !== 201) return problems.push(`signup.verify-otp ${signed.status}`);
  const owner = signed.json.token;
  const loc = signed.json.user.locationId;

  let invite = await call('invites.get', 'GET', `/api/invites/${loc}`, { token: owner });
  if (!invite.json.active) invite = await call('invites.regenerate', 'POST', `/api/invites/${loc}/regenerate`, { token: owner, body: {} });
  const inviteToken = new URL(invite.json.active.inviteUrl).searchParams.get('invite');

  const jOtp = await call('join.request-otp', 'POST', '/api/join/request-otp', { body: { phone: staffPhone }, ip: staffIp });
  const joined = await call('join.verify-otp', 'POST', '/api/join/verify-otp', { body: { phone: staffPhone, code: jOtp.json.devCode, inviteToken, fullName: `${TAG} staff ${n}` }, ip: staffIp });
  if (joined.status >= 300) return problems.push(`join.verify-otp ${joined.status}`);
  const pending = await call('join.pending', 'GET', `/api/join/${loc}/pending`, { token: owner });
  const request = (pending.json.requests ?? pending.json.pending ?? []).find?.((r) => r.fullName === `${TAG} staff ${n}`);
  if (!request) return problems.push('join request not listed for its own venue');
  const approved = await call('join.approve', 'PATCH', `/api/join/${request.id}`, { token: owner, body: { decision: 'approve' } });
  if (approved.status >= 300) return problems.push(`join.approve ${approved.status}`);

  const role = await call('roles.create', 'POST', '/api/roles', { token: owner, body: { name: `${TAG} Server` } });
  const roleId = role.json.role?.id ?? role.json.id;
  const directory = await call('staff-directory.list', 'GET', `/api/staff-directory/${loc}`, { token: owner });
  const staffUser = (directory.json.staff ?? directory.json.entries ?? []).find?.((u) => u.fullName === `${TAG} staff ${n}`);
  if (!staffUser) return problems.push('approved staff member missing from their own directory');
  const monday = nextMonday();
  const created = [];
  for (const [day, start, end] of [[0, '09:00', '17:00'], [2, '12:00', '20:00'], [4, '16:00', '23:00']]) {
    const d = new Date(`${monday}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + day);
    const s = await call('shifts.create', 'POST', '/api/shifts', { token: owner, body: { roleId, userId: staffUser.id, date: d.toISOString().slice(0, 10), start, end } });
    if (s.status === 201) created.push(s.json.shift?.id ?? s.json.id);
    else problems.push(`shifts.create ${s.status}`);
  }
  const published = await call('rota.publish', 'POST', `/api/shifts/${loc}/publish`, { token: owner, body: { weekStart: monday } });
  if (published.status !== 200) problems.push(`rota.publish ${published.status}`);

  // The join code was requested seconds ago: age it past the per-phone resend wait, as a real staff member would wait.
  await prisma.$executeRaw`UPDATE otp_codes SET created_at = created_at - interval '60 seconds' WHERE phone = ${staffPhone}`;
  const lOtp = await call('login.request-otp', 'POST', '/api/identity/request-otp', { body: { phone: staffPhone }, ip: staffIp });
  const login = await call('login.verify-otp', 'POST', '/api/identity/verify-otp', { body: { phone: staffPhone, code: lOtp.json.devCode }, ip: staffIp });
  if (login.status !== 200) return problems.push(`login.verify-otp ${login.status}`);
  const mine = await call('my-shifts', 'GET', '/api/my-shifts', { token: login.json.token });
  const mineIds = (mine.json.shifts ?? []).map((s) => s.id);
  if (mineIds.some((id) => !created.includes(id))) problems.push('My Shifts returned a shift this venue did not create');

  const week = await call('venue.shifts', 'GET', `/api/shifts/${loc}?weekStart=${monday}`, {});
  if ((week.json.shifts ?? []).some((s) => !created.includes(s.id))) problems.push("a venue's rota read returned another venue's shift");
  await call('venue.publish-status', 'GET', `/api/shifts/${loc}/publish-status?weekStart=${monday}`, {});
  await call('venue.announcements', 'GET', `/api/announcements/${loc}`, {});
  await call('venue.shoutouts', 'GET', `/api/shoutouts/${loc}`, {});
}

// ---- abuse from one client ----------------------------------------------------------------
async function abuse(round) {
  const ip = `10.${round}.250.250`;
  const statuses = [];
  for (let i = 0; i < 25; i++) statuses.push((await call('abuse.login-spray', 'POST', '/api/identity/request-otp', { body: { phone: phone() }, ip })).status);
  if (!statuses.includes(429)) problems.push('code-request spray from one client was never limited');
  const p = phone();
  const otp = await call('abuse.signup-otp', 'POST', '/api/signup/request-otp', { body: { phone: p }, ip: `10.${round}.251.1` });
  for (let i = 0; i < 8; i++) {
    await call('abuse.wrong-code', 'POST', '/api/signup/verify-otp', { body: { phone: p, code: '000001', fullName: `${TAG} x`, venueName: `${TAG} x` }, ip: `10.${round}.251.1` });
  }
  void otp;
}

// ---- run ------------------------------------------------------------------------------------
const prisma = new PrismaClient();
const memory = [];
let sampler;
try {
  await waitForHealth();
  sampler = setInterval(() => memory.push(rssMb(server.pid)), 2000);
  for (const [round, users] of sizes.entries()) {
    const started = Date.now();
    await Promise.all(Array.from({ length: users }, (_, n) => venueJourney(n, round + 1).catch((err) => problems.push(`journey threw: ${err.message}`))));
    await abuse(round + 1);
    console.log(`[load-smoke] ${users} concurrent venues: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
} finally {
  clearInterval(sampler);
  server.kill();
  await prisma.otpCode.deleteMany({ where: { phone: { in: pool } } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  await prisma.$disconnect();
}

// ---- report ---------------------------------------------------------------------------------
const log = serverLog.join('');
const fivexx = [...samples.values()].reduce((n, s) => n + [...s.statuses].filter(([st]) => st >= 500 || st === -1).reduce((m, [, c]) => m + c, 0), 0);
console.log('\nendpoint                     n     p50ms   p95ms   maxms   statuses');
for (const [name, s] of [...samples].sort()) {
  const st = [...s.statuses].map(([k, v]) => `${k}x${v}`).join(' ');
  console.log(`${name.padEnd(26)} ${String(s.ms.length).padStart(4)} ${pct(s.ms, 50).toFixed(0).padStart(8)} ${pct(s.ms, 95).toFixed(0).padStart(7)} ${Math.max(...s.ms).toFixed(0).padStart(7)}   ${st}`);
}
const mem = memory.filter(Number.isFinite);
console.log(`\nserver memory (MB): start ${mem[0]?.toFixed(0)} max ${Math.max(...mem).toFixed(0)} end ${mem.at(-1)?.toFixed(0)}`);
console.log(`5xx or connection failures: ${fivexx}`);
console.log(`unhandled rejections in server log: ${(log.match(/Unhandled|unhandledRejection/g) ?? []).length}`);
console.log(`pool exhaustion / init errors in server log: ${(log.match(/P2024|Timed out fetching a new connection|PrismaClientInitializationError/g) ?? []).length}`);
console.log(`server exited during the run: ${serverExited !== null && serverExited !== 0 ? 'yes' : 'no'}`);
console.log(`problems (${problems.length}): ${[...new Set(problems)].join('; ') || 'none'}`);
process.exitCode = fivexx || problems.length ? 1 : 0;
