# People + Identity/Onboarding/Join Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the "People" and "Identity/Onboarding/Join" sections of the 2026-08-25 build directive as one phase (per explicit user instruction to combine them). Extend Staff Directory with real fields already sitting unused on `User` (phone, start date, employment status) plus two genuinely new fields (venue display, preferred language); build a real Training & Policy document hub; build this app's first-ever identity layer (lightweight phone+OTP, matched against the roster, not a full account/password system); build Join (self-registration that auto-matches an existing roster row by phone, falling back to a real Pending Approvals queue); build My Shifts and Profile for the first time (currently a one-line placeholder); build self-service availability marking (informational only, never a hard block); and build the onboarding wizard on top of the real, already-working upload/confirm roster-parsing flow — not a mock.

**Architecture:** This phase introduces the one piece of infrastructure nothing before it has needed: a real (if intentionally lightweight) identity concept. A phone number is verified via a one-time code (`OtpCode`, newly modeled) and, on success, issued a bearer `Session` token (newly modeled) — no password, no email/OAuth, matching the directive's explicit "not full account/password auth" instruction. That session is the "who is asking" for every staff-facing screen this phase adds (My Shifts, Profile, availability marking) — sent as a header, checked against the `Session` table, resolved to a real `User` row. Join reuses the exact same OTP-verification code path; the only difference is what happens after verification succeeds: an existing `User` match logs a session in directly, while no match creates a real `JoinRequest` row and routes to a "pending approval" state instead of a session. Pending Approvals (the People-section item that explicitly "depends on Join existing first") is the screen that resolves those `JoinRequest` rows — approving one either links it to an existing unmatched `User` or creates a brand-new one, mirroring the pattern this codebase already uses for approve/decline flows (`ApprovalsPanel.tsx`'s pending/decided list, reused stylistically, not copy-pasted). The onboarding wizard is real UI wrapped around the already-real `ShiftUpload`/`schedules.ts` upload-confirm endpoints built in an earlier phase — this plan does not touch the parser at all, only adds a venue/review/invite shell around it, per the directive's explicit "do not rebuild the roster-parsing step as a mock" instruction.

**Tech Stack:** Same as every prior phase (React 19, TypeScript strict, Vite, Tailwind v4, Express + Prisma + Postgres, `node:test`), plus two additions:
- **`qrcode`** (new npm dependency, server-side): a small, pure-JS QR-code generator with no native bindings. Needed because the directive explicitly requires the onboarding wizard to "end in a QR + WhatsApp invite link," and no QR generation exists anywhere in this codebase or its dependencies. Server-side generation (returning a data-URL PNG) was chosen over a client-side canvas library so the invite link's QR encoding logic lives in one place, next to where the invite link itself is minted.
- **Node's built-in `crypto` module** (no new dependency) for OTP generation (`crypto.randomInt`) and session-token generation (`crypto.randomBytes`) — this codebase has no `bcrypt`/`jsonwebtoken`/similar dependency anywhere, and none is needed for a lightweight, non-password identity model.

**Spec:** This plan implements the "People" and "Identity / Onboarding / Join" sections of the user's 2026-08-25 build directive:

> **People**
> Extend Staff Directory fields: add venue, language, phone, start date, employment status. Do not add contract hours — already decided against, DIFC/free-zone contracts are flat-salary.
> Build Training & Policy document hub (upload/download PDFs by category) fully.
> Build Pending Approvals ("Needs review") queue — depends on Join existing first, build after.
>
> **Identity / Onboarding / Join**
> Use our already-locked lightweight identity model: phone + OTP matched against the roster (not full account/password auth). This is enough to build My Shifts, Profile, and Join on top of.
> Build My Shifts (staff home: pending-approval banner, next-5-shifts, announcements/shoutouts feed) and Profile (account card, notification preferences) using that identity.
> Build self-service availability marking (unavailable/preferred per day) — RotaBuilder should show this as an informational warning when scheduling over it, not a hard compliance block.
> Build the onboarding wizard (venue → roster → review → invite) using our real upload/confirm endpoints — do not rebuild the roster-parsing step as a mock like Lovable's 1.4s timeout version. Ends in a QR + WhatsApp invite link.
> Skip the "Get Started" checklist — already removed once as a redundant duplicate of the real onboarding flow; don't reintroduce it.
> Build Join: phone + OTP self-registration, auto-match against the roster by phone digits, fallback to manual entry landing in Pending Approvals.

## Global Constraints

- **No component-testing infrastructure** (no jsdom/RTL/vitest) — same as every prior phase. Pure-logic/backend-logic gets real `node:test` unit tests (this repo's established `withServer()` real-app-real-DB pattern, see `server/src/routes/shifts.test.ts`/`floorPlan.test.ts`); React component work is verified via `npm run build`/`npm run typecheck` plus real API/DB smoke tests, with an explicit manual browser-check instruction for the human — never claim visual output is verified.
- **OTP delivery is an honest, clearly-labeled placeholder, not a real SMS integration.** No SMS provider dependency exists anywhere in this codebase (no Twilio/similar), and none is added by this plan — that would be new infrastructure this phase doesn't call for. Exactly like `RotaPublish.notifiedCount` (Scheduling phase) and `SectionAssignment.notifiedAt` (Floor Plan phase) before it, the OTP-request endpoint does the real work (generates a real, hashed, single-use, expiring code and stores it) but "delivery" is a `console.log` on the server (clearly commented as a stand-in for a future SMS integration) plus, only when `NODE_ENV !== 'production'`, the code is also echoed back in the API response so this can be exercised end-to-end without a real phone — never in a production build. Do not add or stub a real SMS send.
- **OTP codes and session tokens are hashed at rest, never stored in plaintext.** Use `crypto.createHash('sha256')` (already-available, no new dependency) — this is a correctness/security baseline, not scope creep, since these are exactly the two secrets this phase's entire security model rests on.
- **Route/client conventions**: `Router()`, explicit validation before any mutating DB call (a referenced user/location must be checked to exist — 404 if not), `try/catch` with `console.error` + JSON `{error}` on failure, `.js` extensions on relative server-side imports, real audit-log writes for state-changing actions where this codebase already does so for comparable actions (approve/decline, create/update).
- **Migrations** via the same non-interactive Prisma workflow established during the Floor Plan phase when `migrate dev` can't run interactively in this environment (`prisma migrate diff --from-url <live-db> --to-schema-datamodel prisma/schema.prisma --script`, hand-placed into a correctly-timestamped migration folder, applied via `prisma migrate deploy`) — never hand-written SQL from scratch, and never fall back to `prisma db push` (no migration history) unless `migrate dev` and the diff-based workaround both genuinely fail.
- **Commit hygiene**: every task stages only its own named files — never `git add -A`/`.`. This repo's working tree routinely has unrelated pre-existing modified/untracked files; leave them alone. **Do not touch `.claude/settings.json` or `.claude/settings.local.json` under any circumstances** — if any subagent hits a tool/permission denial for any reason during this plan, it must stop and report BLOCKED/NEEDS_CONTEXT rather than attempt to edit either file; this is a hard, non-negotiable rule for this plan, following a real incident during the Floor Plan phase and the deny-list hardening that followed it.
- **No `localStorage`-only mock, anywhere.** Every piece of state this plan touches is real, backend-persisted data. The one narrow exception, already established by this codebase's own convention: a session TOKEN itself is stored in the browser (`localStorage`, mirroring how a real app stores a bearer token client-side) — the session's validity, expiry, and the identity it resolves to are entirely server-side and real.
- **Two judgment calls made while writing this plan, documented here rather than silently guessed (neither is hard to reverse):**
  1. **"Venue" in the extended Staff Directory is the existing `Location` relation, displayed read-only — not a new field.** Every `User` already has a required `locationId` FK to a single `Location`; this codebase has no multi-venue UI anywhere, and "add venue" most plausibly means "show which venue this person belongs to," which the existing relation already answers. Reversible later if a genuine multi-venue assignment concept is ever wanted.
  2. **"Employment status" reuses the existing `User.isActive`/`terminatedAt` fields (exposed in the UI for the first time) rather than a new enum.** Both fields already exist and already capture exactly this concept (active vs. terminated, with a real termination date) — adding a parallel status enum would create two sources of truth for the same fact. "Start date" is the existing `hiredAt` field, likewise exposed for the first time.
- **Explicitly cut, per this codebase's own established precedents — do not build these:** staff self-claiming of open shifts (`Decisions.md`: "removed, manager-assigns culture"); the "Get Started" checklist (`Decisions.md`: "removed as redundant duplicate... don't resurrect"); WhatsApp message *parsing* (only a WhatsApp *link-sharing* destination for the invite link is in scope — never a parsing source); a hard compliance block on scheduling over a marked-unavailable day (informational warning only, explicitly per the directive).

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` (modify) | `OtpCode`, `Session`, `JoinRequest`, `PolicyDocument`, `AvailabilityMark` models; new `AvailabilityType` enum; 2 new `AuditAction` values. |
| `server/src/lib/identity.ts` (new) | Shared OTP/session helpers: hash, generate, verify, issue/resolve session — used by both the Identity route and Join route so the two never drift. |
| `server/src/middleware/requireSession.ts` (new) | Express middleware resolving a bearer session token to a real `User`, for the staff-facing routes this phase adds. |
| `server/src/routes/identity.ts` (new) | `POST /request-otp`, `POST /verify-otp` (login path — phone must already match a `User`). |
| `server/src/routes/join.ts` (new) | `POST /request-otp`, `POST /verify-otp` (join path — auto-matches or creates a `JoinRequest`), `GET /:locationId/pending` + `PATCH /:requestId` (Pending Approvals). |
| `server/src/routes/myShifts.ts` (new) | `GET /` (session-resolved: next-5-shifts + pending-approval flag), reusing existing shift/roster read logic. |
| `server/src/routes/availability.ts` (new) | `GET /:userId?weekStart=`, `POST /`, `DELETE /:id` for self-service availability marks. |
| `server/src/routes/policyDocuments.ts` (new) | `GET /:locationId`, `POST /` (upload), `DELETE /:id` for the Training & Policy hub. |
| `server/src/routes/staffDirectory.ts` (modify) | GET/POST/PATCH extended to include/accept `phone`, `preferredLanguage`, `hiredAt`, `isActive`, `venueName`. |
| `server/src/app.ts` (modify) | Mount `identityRouter`, `joinRouter`, `myShiftsRouter`, `availabilityRouter`, `policyDocumentsRouter`. |
| `src/api/identity.ts` (new) | Client for `/api/identity` — request/verify OTP, local session-token storage helpers. |
| `src/api/join.ts` (new) | Client for `/api/join` — request/verify OTP (join path), pending-approvals list/decide. |
| `src/api/myShifts.ts` (new) | Client for `/api/my-shifts`. |
| `src/api/availability.ts` (new) | Client for `/api/availability`. |
| `src/api/policyDocuments.ts` (new) | Client for `/api/policy-documents`. |
| `src/api/staffDirectory.ts` (modify) | Extended `StaffDirectoryEntry`, extended add/update calls. |
| `src/state/IdentityContext.tsx` (new) | React context holding the current session (if any): phone, resolved `User`, login/logout, reused by My Shifts/Profile/Join. |
| `src/components/StaffDirectory.tsx` (modify) | New editable fields: phone, preferred language (with autocomplete), start date, employment status toggle; venue shown read-only. |
| `src/components/PolicyDocuments.tsx` (new) | Training & Policy hub: upload form + category-grouped list with download links. |
| `src/components/PendingApprovals.tsx` (new) | Approve/decline queue for `JoinRequest` rows, styled after `ApprovalsPanel.tsx`'s pending/decided pattern. |
| `src/components/JoinFlow.tsx` (new) | Phone → OTP → (session | pending-approval landing) self-registration flow. |
| `src/components/OnboardingWizard.tsx` (new) | 4-step wizard: venue → roster (reuses `ShiftUpload`) → review → invite (QR + WhatsApp link). |
| `src/routes/MyShiftsRoute.tsx` (new) | Mounts the My Shifts staff-home screen. |
| `src/routes/JoinRoute.tsx` (new) | Mounts `JoinFlow`. |
| `src/routes/OnboardingRoute.tsx` (new) | Mounts `OnboardingWizard`. |
| `src/routes/ProfileRoute.tsx` (modify) | Replaces the 1-line placeholder with a real account card + notification-preferences UI. |
| `src/routes/PeopleRoute.tsx` (modify) | Mounts `PolicyDocuments` and `PendingApprovals` alongside the existing `StaffDirectory`. |
| `src/components/FloorPlan/AssignmentBoard.tsx` / `src/components/shiftsync/RotaBuilder.tsx` (modify) | Informational (non-blocking) availability warning when a manager schedules over a day someone marked unavailable/preferred-off. |
| `src/router.tsx` (modify) | Adds `/join`, `/onboarding`, `/my-shifts` routes. |

---

### Task 1: Prisma schema — identity, join, availability, policy documents

**Files:**
- Modify: `prisma/schema.prisma`
- Migration: `prisma/migrations/<timestamp>_add_identity_join_availability_policy_docs/` (generated)

**Interfaces:**
- Produces: `OtpCode`, `Session`, `JoinRequest`, `PolicyDocument`, `AvailabilityMark` models; `AvailabilityType` enum (`UNAVAILABLE`, `PREFERRED_OFF`); `AuditAction` gains `JOIN_APPROVED`, `JOIN_DECLINED`.

- [ ] **Step 1: Add the schema changes**

Add to the `AuditAction` enum (after its last value):

```prisma
  JOIN_APPROVED
  JOIN_DECLINED
```

Add these new models near the end of the file:

```prisma
// ---------------------------------------------------------------------------
// 10. IDENTITY — lightweight phone+OTP, not a full account/password system
// ---------------------------------------------------------------------------

// A one-time code sent to a phone number, for either the login path
// (identity.ts, phone must already match a real User) or the join path
// (join.ts, phone may not match anyone yet). `purpose` keeps the two from
// being interchangeable — a code requested for login can't be replayed to
// join, and vice versa. `codeHash` is sha256, never the plaintext code.
enum OtpPurpose {
  LOGIN
  JOIN
}

model OtpCode {
  id        String     @id @default(cuid())
  phone     String
  codeHash  String     @map("code_hash")
  purpose   OtpPurpose
  expiresAt DateTime   @map("expires_at")
  consumedAt DateTime? @map("consumed_at")
  attempts  Int        @default(0)
  createdAt DateTime   @default(now()) @map("created_at")

  @@index([phone, purpose])
  @@map("otp_codes")
}

// A logged-in session — a bearer token issued after a successful OTP
// verification against a real, matched User. No password, no email/OAuth;
// this IS the account system, deliberately lightweight per the product
// decision this phase implements.
model Session {
  id        String   @id @default(cuid())
  userId    String   @map("user_id")
  tokenHash String   @unique @map("token_hash")
  expiresAt DateTime @map("expires_at")
  createdAt DateTime @default(now()) @map("created_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("sessions")
}

// A self-registration attempt whose phone number did NOT match an existing
// User at verification time. Sits in Pending Approvals until a manager
// approves (creating or linking a real User) or declines it. An
// auto-matched join never creates one of these — only the "fallback to
// manual entry" path the directive describes.
enum JoinRequestStatus {
  PENDING
  APPROVED
  DECLINED
}

model JoinRequest {
  id             String            @id @default(cuid())
  locationId     String            @map("location_id")
  phone          String
  fullName       String            @map("full_name")
  status         JoinRequestStatus @default(PENDING)
  reviewedById   String?           @map("reviewed_by_id")
  reviewedAt     DateTime?         @map("reviewed_at")
  createdUserId  String?           @map("created_user_id")
  createdAt      DateTime          @default(now()) @map("created_at")

  location    Location @relation(fields: [locationId], references: [id], onDelete: Cascade)
  reviewedBy  User?    @relation("JoinRequestReviewedBy", fields: [reviewedById], references: [id], onDelete: SetNull)
  createdUser User?    @relation("JoinRequestCreatedUser", fields: [createdUserId], references: [id], onDelete: SetNull)

  @@index([locationId, status])
  @@map("join_requests")
}

// ---------------------------------------------------------------------------
// 11. SELF-SERVICE AVAILABILITY — informational only, never a hard block
// ---------------------------------------------------------------------------

enum AvailabilityType {
  UNAVAILABLE
  PREFERRED_OFF
}

model AvailabilityMark {
  id        String           @id @default(cuid())
  userId    String           @map("user_id")
  date      DateTime         @db.Date
  type      AvailabilityType
  note      String?
  createdAt DateTime         @default(now()) @map("created_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, date])
  @@index([userId, date])
  @@map("availability_marks")
}

// ---------------------------------------------------------------------------
// 12. TRAINING & POLICY DOCUMENT HUB
// ---------------------------------------------------------------------------

model PolicyDocument {
  id           String   @id @default(cuid())
  locationId   String   @map("location_id")
  category     String
  title        String
  fileUrl      String   @map("file_url")
  originalName String?  @map("original_name")
  mimeType     String   @map("mime_type")
  uploadedById String?  @map("uploaded_by_id")
  createdAt    DateTime @default(now()) @map("created_at")

  location   Location @relation(fields: [locationId], references: [id], onDelete: Cascade)
  uploadedBy User?    @relation("PolicyDocumentUploadedBy", fields: [uploadedById], references: [id], onDelete: SetNull)

  @@index([locationId, category])
  @@map("policy_documents")
}
```

Add the back-relation arrays. On `Location` (alongside its existing relation arrays):

```prisma
  joinRequests    JoinRequest[]
  policyDocuments PolicyDocument[]
```

On `User` (alongside its existing relation arrays):

```prisma
  sessions                  Session[]
  joinRequestsReviewed       JoinRequest[]      @relation("JoinRequestReviewedBy")
  joinRequestsCreatedFrom    JoinRequest[]      @relation("JoinRequestCreatedUser")
  availabilityMarks          AvailabilityMark[]
  policyDocumentsUploaded    PolicyDocument[]   @relation("PolicyDocumentUploadedBy")
```

- [ ] **Step 2: Generate and apply the migration**

If `npx prisma migrate dev --name add_identity_join_availability_policy_docs` fails with the same "non-interactive environment" error seen during the Floor Plan phase, use the same fallback that worked then: generate the SQL via `npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script` into a correctly-timestamped `prisma/migrations/<ts>_add_identity_join_availability_policy_docs/migration.sql`, then apply with `npx prisma migrate deploy`. Confirm with `npx prisma migrate status` and `npx prisma validate`.

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add identity (OTP/session), join requests, availability marks, and policy documents"
```

---

### Task 2: Shared identity/session helper + session-resolving middleware

**Files:**
- Create: `server/src/lib/identity.ts`
- Create: `server/src/lib/identity.test.ts`
- Create: `server/src/middleware/requireSession.ts`

**Interfaces:**
- Produces: `generateOtp(): string`, `hashOtp(code: string): string`, `createOtpCode(phone, purpose): Promise<{id, plainCode}>`, `verifyOtpCode(phone, purpose, code): Promise<{ok: boolean; reason?: string}>`, `issueSession(userId): Promise<{plainToken, expiresAt}>`, `resolveSession(plainToken): Promise<User | null>`. `requireSession` Express middleware attaching `req.user` (a real `User`) or 401.
- Consumed by: Tasks 3, 4, 5, 6.

- [ ] **Step 1: Write the failing tests first**

Create `server/src/lib/identity.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateOtp, hashOtp } from './identity.js';

test('generateOtp returns a 6-digit numeric string', () => {
  const code = generateOtp();
  assert.match(code, /^\d{6}$/);
});

test('generateOtp is not deterministic across calls', () => {
  const codes = new Set(Array.from({ length: 20 }, () => generateOtp()));
  assert.ok(codes.size > 1, 'expected at least some variation across 20 generated codes');
});

test('hashOtp is deterministic for the same input and never returns the plaintext', () => {
  const a = hashOtp('123456');
  const b = hashOtp('123456');
  assert.equal(a, b);
  assert.notEqual(a, '123456');
  assert.equal(a.length, 64); // sha256 hex digest
});

test('hashOtp produces different hashes for different codes', () => {
  assert.notEqual(hashOtp('123456'), hashOtp('654321'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test server/src/lib/identity.test.ts`
Expected: FAIL — `Cannot find module './identity.js'`.

- [ ] **Step 3: Write the helper**

Create `server/src/lib/identity.ts`:

```typescript
import { randomInt, randomBytes, createHash } from 'node:crypto';
import { prisma } from './prisma.js';
import type { OtpPurpose, User } from '@prisma/client';

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — long-lived, no refresh flow in this lightweight model
const MAX_OTP_ATTEMPTS = 5;

/** Real 6-digit numeric code. Never logged/returned in production (see the request-otp routes). */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** sha256 hex digest — codes and session tokens are never stored in plaintext. */
export function hashOtp(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Creates and stores a new OTP for (phone, purpose), invalidating any prior
 * unconsumed code for the same (phone, purpose) pair so only the most
 * recently requested code is ever valid.
 */
export async function createOtpCode(
  phone: string,
  purpose: OtpPurpose,
): Promise<{ id: string; plainCode: string; expiresAt: Date }> {
  await prisma.otpCode.updateMany({
    where: { phone, purpose, consumedAt: null },
    data: { consumedAt: new Date() }, // invalidate — not a real "use," just supersession
  });
  const plainCode = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  const created = await prisma.otpCode.create({
    data: { phone, purpose, codeHash: hashOtp(plainCode), expiresAt },
  });
  return { id: created.id, plainCode, expiresAt };
}

/**
 * Verifies a submitted code against the most recent unconsumed OTP for
 * (phone, purpose). Consumes it (success or failure) so a code can never be
 * replayed, and rate-limits guesses via `attempts`.
 */
export async function verifyOtpCode(
  phone: string,
  purpose: OtpPurpose,
  submittedCode: string,
): Promise<{ ok: boolean; reason?: string }> {
  const record = await prisma.otpCode.findFirst({
    where: { phone, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!record) return { ok: false, reason: 'No active code for this phone number — request a new one.' };
  if (record.expiresAt < new Date()) {
    await prisma.otpCode.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
    return { ok: false, reason: 'That code has expired — request a new one.' };
  }
  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    await prisma.otpCode.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
    return { ok: false, reason: 'Too many incorrect attempts — request a new code.' };
  }
  if (hashOtp(submittedCode) !== record.codeHash) {
    await prisma.otpCode.update({ where: { id: record.id }, data: { attempts: { increment: 1 } } });
    return { ok: false, reason: 'Incorrect code.' };
  }
  await prisma.otpCode.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
  return { ok: true };
}

/** Issues a new bearer session token for a real, already-verified User. */
export async function issueSession(userId: string): Promise<{ plainToken: string; expiresAt: Date }> {
  const plainToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({
    data: { userId, tokenHash: hashOtp(plainToken), expiresAt },
  });
  return { plainToken, expiresAt };
}

/** Resolves a bearer token to its real User, or null if missing/expired/unknown. */
export async function resolveSession(plainToken: string): Promise<User | null> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashOtp(plainToken) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date()) return null;
  return session.user;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test server/src/lib/identity.test.ts`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Write the middleware**

Create `server/src/middleware/requireSession.ts`:

```typescript
import type { Request, Response, NextFunction } from 'express';
import type { User } from '@prisma/client';
import { resolveSession } from '../lib/identity.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/** Resolves the `Authorization: Bearer <token>` header to a real User, or 401s. */
export async function requireSession(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) return res.status(401).json({ error: 'Missing or malformed Authorization header.' });

  const user = await resolveSession(token);
  if (!user) return res.status(401).json({ error: 'Session is invalid or has expired.' });

  req.user = user;
  next();
}
```

- [ ] **Step 6: Verify**

Run: `npm run server:typecheck`
Expected: clean (nothing consumes these yet — that starts at Task 3).

- [ ] **Step 7: Commit**

```bash
git add server/src/lib/identity.ts server/src/lib/identity.test.ts server/src/middleware/requireSession.ts
git commit -m "feat: add lightweight OTP/session identity helpers and session middleware"
```

---

### Task 3: Identity route (login) + Join route (self-registration + Pending Approvals)

**Files:**
- Create: `server/src/routes/identity.ts`
- Create: `server/src/routes/join.ts`
- Modify: `server/src/app.ts` (mount both)

**Interfaces:**
- Produces: `POST /api/identity/request-otp`, `POST /api/identity/verify-otp` (login — 404 if phone matches no `User`); `POST /api/join/request-otp`, `POST /api/join/verify-otp` (join — auto-matches or creates a `JoinRequest`), `GET /api/join/:locationId/pending`, `PATCH /api/join/:requestId` (approve/decline).
- Consumed by: Task 6's `src/api/identity.ts`/`src/api/join.ts` clients.

- [ ] **Step 1: Normalize phone matching**

Both routes need to match a submitted phone number against `User.phone` tolerant of formatting differences (spaces, dashes, a leading `+`/`00` country-code prefix). Add a small local helper at the top of `server/src/routes/join.ts` (and import it into `identity.ts`):

```typescript
/** Digits only, dropping a leading international-dialing prefix so "+971 50 123 4567", "00971501234567", and "0501234567" can all match the same stored number. */
function phoneDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.replace(/^00/, '').replace(/^971/, '');
}
```

- [ ] **Step 2: Write `server/src/routes/identity.ts`**

```typescript
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { createOtpCode, verifyOtpCode, issueSession } from '../lib/identity.js';

export const identityRouter = Router();

function phoneDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.replace(/^00/, '').replace(/^971/, '');
}

/** POST /api/identity/request-otp — body: { phone } — login path, phone must already match a real User. */
identityRouter.post('/request-otp', async (req, res) => {
  try {
    const phone = String(req.body?.phone ?? '').trim();
    if (!phone) return res.status(400).json({ error: 'phone is required.' });

    const digits = phoneDigits(phone);
    const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true, phone: true } });
    const match = users.find((u) => u.phone && phoneDigits(u.phone) === digits);
    if (!match) return res.status(404).json({ error: 'No active staff member found with that phone number.' });

    const { plainCode, expiresAt } = await createOtpCode(phone, 'LOGIN');
    console.log(`[identity] OTP for ${phone} (LOGIN): ${plainCode} — no SMS integration exists; this is a stand-in until one is added.`);

    return res.status(200).json({
      expiresAt: expiresAt.toISOString(),
      devCode: process.env.NODE_ENV === 'production' ? undefined : plainCode,
    });
  } catch (err) {
    console.error('[identity.requestOtp] failed', err);
    return res.status(500).json({ error: 'Unexpected error while requesting a code.' });
  }
});

/** POST /api/identity/verify-otp — body: { phone, code } */
identityRouter.post('/verify-otp', async (req, res) => {
  try {
    const phone = String(req.body?.phone ?? '').trim();
    const code = String(req.body?.code ?? '').trim();
    if (!phone || !code) return res.status(400).json({ error: 'phone and code are required.' });

    const result = await verifyOtpCode(phone, 'LOGIN', code);
    if (!result.ok) return res.status(401).json({ error: result.reason });

    const digits = phoneDigits(phone);
    const users = await prisma.user.findMany({ where: { isActive: true } });
    const match = users.find((u) => u.phone && phoneDigits(u.phone) === digits);
    if (!match) return res.status(404).json({ error: 'No active staff member found with that phone number.' });

    const { plainToken, expiresAt } = await issueSession(match.id);
    return res.status(200).json({
      token: plainToken,
      expiresAt: expiresAt.toISOString(),
      user: { id: match.id, fullName: match.fullName, jobTitle: match.jobTitle },
    });
  } catch (err) {
    console.error('[identity.verifyOtp] failed', err);
    return res.status(500).json({ error: 'Unexpected error while verifying the code.' });
  }
});
```

- [ ] **Step 3: Write `server/src/routes/join.ts`**

```typescript
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { createOtpCode, verifyOtpCode, issueSession } from '../lib/identity.js';

export const joinRouter = Router();

function phoneDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.replace(/^00/, '').replace(/^971/, '');
}

/** POST /api/join/request-otp — body: { phone } — join path, no existing-match requirement. */
joinRouter.post('/request-otp', async (req, res) => {
  try {
    const phone = String(req.body?.phone ?? '').trim();
    if (!phone) return res.status(400).json({ error: 'phone is required.' });

    const { plainCode, expiresAt } = await createOtpCode(phone, 'JOIN');
    console.log(`[join] OTP for ${phone} (JOIN): ${plainCode} — no SMS integration exists; this is a stand-in until one is added.`);

    return res.status(200).json({
      expiresAt: expiresAt.toISOString(),
      devCode: process.env.NODE_ENV === 'production' ? undefined : plainCode,
    });
  } catch (err) {
    console.error('[join.requestOtp] failed', err);
    return res.status(500).json({ error: 'Unexpected error while requesting a code.' });
  }
});

/**
 * POST /api/join/verify-otp — body: { locationId, phone, code, fullName? }
 *
 * On success: if `phone` matches an existing active User (by digits), issues
 * a real session immediately — this IS the auto-match the directive
 * describes. Otherwise creates a real PENDING JoinRequest (fullName
 * required in this branch) and returns `pending: true` with no session —
 * the "fallback to manual entry landing in Pending Approvals" path.
 */
joinRouter.post('/verify-otp', async (req, res) => {
  try {
    const locationId = String(req.body?.locationId ?? '').trim();
    const phone = String(req.body?.phone ?? '').trim();
    const code = String(req.body?.code ?? '').trim();
    const fullName = req.body?.fullName ? String(req.body.fullName).trim() : null;
    if (!locationId) return res.status(400).json({ error: 'locationId is required.' });
    if (!phone || !code) return res.status(400).json({ error: 'phone and code are required.' });

    const location = await prisma.location.findUnique({ where: { id: locationId } });
    if (!location) return res.status(404).json({ error: `Location "${locationId}" not found.` });

    const result = await verifyOtpCode(phone, 'JOIN', code);
    if (!result.ok) return res.status(401).json({ error: result.reason });

    const digits = phoneDigits(phone);
    const users = await prisma.user.findMany({ where: { locationId, isActive: true } });
    const match = users.find((u) => u.phone && phoneDigits(u.phone) === digits);

    if (match) {
      const { plainToken, expiresAt } = await issueSession(match.id);
      return res.status(200).json({
        pending: false,
        token: plainToken,
        expiresAt: expiresAt.toISOString(),
        user: { id: match.id, fullName: match.fullName, jobTitle: match.jobTitle },
      });
    }

    if (!fullName) {
      return res.status(400).json({ error: 'No existing match — fullName is required to submit a join request for manual review.' });
    }
    const joinRequest = await prisma.joinRequest.create({
      data: { locationId, phone, fullName, status: 'PENDING' },
    });
    return res.status(201).json({ pending: true, joinRequestId: joinRequest.id });
  } catch (err) {
    console.error('[join.verifyOtp] failed', err);
    return res.status(500).json({ error: 'Unexpected error while verifying the code.' });
  }
});

/** GET /api/join/:locationId/pending — list PENDING join requests for Pending Approvals. */
joinRouter.get('/:locationId/pending', async (req, res) => {
  try {
    const { locationId } = req.params;
    const requests = await prisma.joinRequest.findMany({
      where: { locationId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
    return res.status(200).json({
      requests: requests.map((r) => ({
        id: r.id,
        phone: r.phone,
        fullName: r.fullName,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('[join.pending.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading pending join requests.' });
  }
});

/**
 * PATCH /api/join/:requestId — body: { decision: 'approve'|'decline', reviewedById?, jobTitle? }
 * Approving creates a real, active User from the request's phone/fullName
 * and links it back onto the request — this is the one place a JoinRequest
 * ever produces a real staff member.
 */
joinRouter.patch('/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    const decision = String(req.body?.decision ?? '');
    const reviewedById = req.body?.reviewedById ? String(req.body.reviewedById).trim() : null;
    if (decision !== 'approve' && decision !== 'decline') {
      return res.status(400).json({ error: 'decision must be "approve" or "decline".' });
    }

    const existing = await prisma.joinRequest.findUnique({ where: { id: requestId } });
    if (!existing) return res.status(404).json({ error: `Join request "${requestId}" not found.` });
    if (existing.status !== 'PENDING') return res.status(409).json({ error: 'This request has already been reviewed.' });

    if (decision === 'decline') {
      await prisma.joinRequest.update({
        where: { id: requestId },
        data: { status: 'DECLINED', reviewedById, reviewedAt: new Date() },
      });
      await prisma.auditLog.create({
        data: { locationId: existing.locationId, actorId: reviewedById, action: 'JOIN_DECLINED', entityType: 'JoinRequest', entityId: requestId, note: `Declined join request for ${existing.fullName}` },
      });
      return res.status(200).json({ status: 'DECLINED' });
    }

    const jobTitle = req.body?.jobTitle ? String(req.body.jobTitle).trim() : null;
    const created = await prisma.user.create({
      data: { locationId: existing.locationId, fullName: existing.fullName, phone: existing.phone, jobTitle },
    });
    await prisma.joinRequest.update({
      where: { id: requestId },
      data: { status: 'APPROVED', reviewedById, reviewedAt: new Date(), createdUserId: created.id },
    });
    await prisma.auditLog.create({
      data: { locationId: existing.locationId, actorId: reviewedById, action: 'JOIN_APPROVED', entityType: 'JoinRequest', entityId: requestId, note: `Approved join request for ${existing.fullName} — created User ${created.id}` },
    });
    return res.status(200).json({ status: 'APPROVED', userId: created.id });
  } catch (err) {
    console.error('[join.decide] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deciding the join request.' });
  }
});
```

- [ ] **Step 4: Mount both**

In `server/src/app.ts`:

```typescript
import { identityRouter } from './routes/identity.js';
import { joinRouter } from './routes/join.js';
// ...
  app.use('/api/identity', identityRouter);
  app.use('/api/join', joinRouter);
```

- [ ] **Step 5: Verify and live smoke-test**

Run: `npm run server:typecheck`
Then, with the server running and a real seed user with a real `phone` value set (set one via a direct Prisma script if none exists yet): request+verify an OTP for that phone via `/api/identity`, confirm a real session token is issued and `resolveSession` (via a throwaway script) resolves it to the right user. Request+verify an OTP for a phone that does NOT match anyone via `/api/join` with a `fullName`, confirm a real `PENDING` `JoinRequest` row is created and no session is issued. List pending requests, approve it, confirm a real new `User` row now exists with that phone/name, confirm the `JoinRequest` flipped to `APPROVED` with `createdUserId` set, confirm a real `AuditLog(JOIN_APPROVED)` row exists. Repeat for decline. Clean up all test rows after.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/identity.ts server/src/routes/join.ts server/src/app.ts
git commit -m "feat: add identity (login) and join (self-registration + pending approvals) routes"
```

---

### Task 4: My Shifts + Availability + Policy Documents backend routes

**Files:**
- Create: `server/src/routes/myShifts.ts`
- Create: `server/src/routes/availability.ts`
- Create: `server/src/routes/policyDocuments.ts`
- Modify: `server/src/app.ts` (mount all three)

**Interfaces:**
- Produces: `GET /api/my-shifts` (session-resolved, next 5 upcoming shifts + a pending-approval flag); `GET/POST/DELETE /api/availability`; `GET/POST/DELETE /api/policy-documents`.

- [ ] **Step 1: `server/src/routes/myShifts.ts`**

```typescript
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireSession } from '../middleware/requireSession.js';

export const myShiftsRouter = Router();

/**
 * GET /api/my-shifts — session-resolved. Returns the next 5 upcoming
 * (today-or-later) shifts for the logged-in user, plus whether they have a
 * JoinRequest still pending review (relevant if they were auto-approved
 * later but the UI wants to show a residual banner — in practice this will
 * almost always be false for a real session, since only an approved/matched
 * identity ever reaches a session at all, but the field is included for a
 * accurate, honest "pending-approval banner" per the directive).
 */
myShiftsRouter.get('/', requireSession, async (req, res) => {
  try {
    const userId = req.user!.id;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const shifts = await prisma.shift.findMany({
      where: { userId, date: { gte: today } },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      take: 5,
      include: { role: { select: { name: true } } },
    });

    const pendingJoinRequest = await prisma.joinRequest.findFirst({
      where: { phone: req.user!.phone ?? undefined, status: 'PENDING' },
    });

    return res.status(200).json({
      pendingApproval: Boolean(pendingJoinRequest),
      shifts: shifts.map((s) => ({
        id: s.id,
        date: s.date.toISOString().slice(0, 10),
        startTime: s.startTime.toISOString(),
        endTime: s.endTime.toISOString(),
        roleName: s.role.name,
        status: s.status,
      })),
    });
  } catch (err) {
    console.error('[myShifts.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading your shifts.' });
  }
});
```

- [ ] **Step 2: `server/src/routes/availability.ts`**

```typescript
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';

export const availabilityRouter = Router();

/** GET /api/availability/:userId?weekStart=YYYY-MM-DD */
availabilityRouter.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const weekStart = String(req.query.weekStart ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return res.status(400).json({ error: 'weekStart query param is required, as YYYY-MM-DD.' });
    }
    const start = new Date(`${weekStart}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);

    const marks = await prisma.availabilityMark.findMany({ where: { userId, date: { gte: start, lt: end } } });
    return res.status(200).json({
      marks: marks.map((m) => ({ id: m.id, date: m.date.toISOString().slice(0, 10), type: m.type, note: m.note })),
    });
  } catch (err) {
    console.error('[availability.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading availability.' });
  }
});

/** POST /api/availability — body: { userId, date, type, note? } — upserts one mark per (userId, date). */
availabilityRouter.post('/', async (req, res) => {
  try {
    const userId = String(req.body?.userId ?? '').trim();
    const dateStr = String(req.body?.date ?? '').trim();
    const type = String(req.body?.type ?? '');
    const note = req.body?.note ? String(req.body.note).trim() : null;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return res.status(400).json({ error: 'date is required, as YYYY-MM-DD.' });
    if (type !== 'UNAVAILABLE' && type !== 'PREFERRED_OFF') {
      return res.status(400).json({ error: 'type must be "UNAVAILABLE" or "PREFERRED_OFF".' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: `Staff member "${userId}" not found.` });

    const date = new Date(`${dateStr}T00:00:00.000Z`);
    const mark = await prisma.availabilityMark.upsert({
      where: { userId_date: { userId, date } },
      create: { userId, date, type: type as 'UNAVAILABLE' | 'PREFERRED_OFF', note },
      update: { type: type as 'UNAVAILABLE' | 'PREFERRED_OFF', note },
    });
    return res.status(201).json({ id: mark.id, date: mark.date.toISOString().slice(0, 10), type: mark.type, note: mark.note });
  } catch (err) {
    console.error('[availability.create] failed', err);
    return res.status(500).json({ error: 'Unexpected error while saving the availability mark.' });
  }
});

/** DELETE /api/availability/:id */
availabilityRouter.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.availabilityMark.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: `Availability mark "${id}" not found.` });
    await prisma.availabilityMark.delete({ where: { id } });
    return res.status(204).send();
  } catch (err) {
    console.error('[availability.delete] failed', err);
    return res.status(500).json({ error: 'Unexpected error while removing the availability mark.' });
  }
});
```

- [ ] **Step 3: `server/src/routes/policyDocuments.ts`**

Follow the exact multer/upload conventions already established in `server/src/routes/floorPlan.ts` (memory storage, size limit, extension-derived filename, real file written to `server/uploads/`):

```typescript
import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { prisma } from '../lib/prisma.js';

export const policyDocumentsRouter = Router();

const UPLOAD_DIR = join(import.meta.dirname, '..', '..', 'uploads', 'policy-documents');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)) cb(null, true);
    else cb(new Error(`Unsupported file type "${file.mimetype || file.originalname}". Upload a .pdf file.`));
  },
});

/** GET /api/policy-documents/:locationId — grouped by category client-side; server returns a flat list. */
policyDocumentsRouter.get('/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    const docs = await prisma.policyDocument.findMany({
      where: { locationId },
      orderBy: [{ category: 'asc' }, { createdAt: 'desc' }],
    });
    return res.status(200).json({
      documents: docs.map((d) => ({
        id: d.id,
        category: d.category,
        title: d.title,
        fileUrl: d.fileUrl,
        originalName: d.originalName,
        createdAt: d.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('[policyDocuments.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading documents.' });
  }
});

/** POST /api/policy-documents/upload — multipart: file, locationId, category, title, uploadedById? */
policyDocumentsRouter.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const locationId = String(req.body?.locationId ?? '').trim();
    const category = String(req.body?.category ?? '').trim();
    const title = String(req.body?.title ?? '').trim();
    const uploadedById = req.body?.uploadedById ? String(req.body.uploadedById).trim() : null;
    if (!locationId) return res.status(400).json({ error: 'locationId is required.' });
    if (!category) return res.status(400).json({ error: 'category is required.' });
    if (!title) return res.status(400).json({ error: 'title is required.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const location = await prisma.location.findUnique({ where: { id: locationId } });
    if (!location) return res.status(404).json({ error: `Location "${locationId}" not found.` });

    await mkdir(UPLOAD_DIR, { recursive: true });
    const filename = `${randomUUID()}.pdf`;
    await writeFile(join(UPLOAD_DIR, filename), req.file.buffer);
    const fileUrl = `/uploads/policy-documents/${filename}`;

    const doc = await prisma.policyDocument.create({
      data: { locationId, category, title, fileUrl, originalName: req.file.originalname, mimeType: req.file.mimetype, uploadedById },
    });
    return res.status(201).json({
      document: { id: doc.id, category: doc.category, title: doc.title, fileUrl: doc.fileUrl, originalName: doc.originalName, createdAt: doc.createdAt.toISOString() },
    });
  } catch (err) {
    console.error('[policyDocuments.upload] failed', err);
    return res.status(500).json({ error: 'Unexpected error while uploading the document.' });
  }
});

/** DELETE /api/policy-documents/:id */
policyDocumentsRouter.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.policyDocument.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: `Document "${id}" not found.` });
    await prisma.policyDocument.delete({ where: { id } });
    return res.status(204).send();
  } catch (err) {
    console.error('[policyDocuments.delete] failed', err);
    return res.status(500).json({ error: 'Unexpected error while deleting the document.' });
  }
});
```

- [ ] **Step 4: Mount all three**

In `server/src/app.ts`:

```typescript
import { myShiftsRouter } from './routes/myShifts.js';
import { availabilityRouter } from './routes/availability.js';
import { policyDocumentsRouter } from './routes/policyDocuments.js';
// ...
  app.use('/api/my-shifts', myShiftsRouter);
  app.use('/api/availability', availabilityRouter);
  app.use('/api/policy-documents', policyDocumentsRouter);
```

- [ ] **Step 5: Verify and live smoke-test**

Run: `npm run server:typecheck`
Then: issue a real session (via Task 3's routes) and call `GET /api/my-shifts` with it as a Bearer token, confirm real upcoming shifts return (create a couple of test future shifts first if none exist) and `pendingApproval` is correctly `false` for a real matched user. Mark a real day unavailable via `POST /api/availability`, confirm it persists and lists correctly for that week, re-post the same date with `PREFERRED_OFF` and confirm the upsert changed the type rather than creating a duplicate row, delete it. Upload a real small test PDF via `POST /api/policy-documents/upload`, confirm it lists and the file is really on disk and fetchable via its `fileUrl`, delete it and confirm the DB row is gone (file cleanup is out of scope, matching this repo's existing floor-plan-image precedent of not deleting the underlying file on record delete — confirm that's really the established precedent before assuming it, don't guess).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/myShifts.ts server/src/routes/availability.ts server/src/routes/policyDocuments.ts server/src/app.ts
git commit -m "feat: add My Shifts, availability marking, and policy documents backend routes"
```

---

### Task 5: Extend Staff Directory backend (phone, language, start date, employment status, venue)

**Files:**
- Modify: `server/src/routes/staffDirectory.ts`

**Interfaces:**
- Produces: GET/POST/PATCH all extended to include/accept `phone`, `preferredLanguage`, `hiredAt`, `isActive`, and a read-only `venueName` (joined `Location.name`).

- [ ] **Step 1: Add `preferredLanguage` to the schema (small addendum to Task 1 — do this here, not there, since it's staff-directory-specific and this task already touches the file it affects)**

Wait — this field must exist on `User` before this task can write to it. Add to `prisma/schema.prisma`'s `User` model (a one-line addition):

```prisma
  preferredLanguage String? @map("preferred_language")
```

Run `npx prisma migrate dev --name add_user_preferred_language` (or the same non-interactive fallback as Task 1 if needed), then proceed with the route changes below.

- [ ] **Step 2: Update `GET /:locationId`**

```typescript
staffDirectoryRouter.get('/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    const users = await prisma.user.findMany({
      where: { locationId, isActive: true },
      orderBy: { fullName: 'asc' },
      include: { role: true, location: { select: { name: true } } },
    });
    return res.status(200).json({
      staff: users.map((u) => ({
        id: u.id,
        fullName: u.fullName,
        jobTitle: u.jobTitle,
        roleId: u.role?.id ?? null,
        roleName: u.role?.name ?? null,
        phone: u.phone,
        preferredLanguage: u.preferredLanguage,
        hiredAt: u.hiredAt ? u.hiredAt.toISOString().slice(0, 10) : null,
        isActive: u.isActive,
        venueName: u.location.name,
      })),
    });
  } catch (err) {
    console.error('[staffDirectory.list] failed', err);
    return res.status(500).json({ error: 'Unexpected error while loading the staff directory.' });
  }
});
```

Note: this deliberately drops the `isActive: true` filter's implication that inactive staff are invisible — since employment status is now a real, user-facing field, a manager needs to see (and un-set) an inactive person too. Change the `where` to `{ locationId }` (no `isActive` filter) so terminated staff remain visible with their real status shown, not silently hidden. Confirm this doesn't break any existing consumer that relies on this endpoint only returning active staff (grep all call sites of `fetchStaffDirectory` before finalizing — if any consumer assumes active-only, filter client-side there instead of regressing this endpoint's new purpose).

- [ ] **Step 3: Update `POST /` and `PATCH /:userId` to accept the new fields**

Extend `POST /`'s body reading and `data` object with `phone`, `preferredLanguage`, `hiredAt` (parse as `YYYY-MM-DD` → `Date`), leave `isActive` at its schema default (`true`) for new hires. Extend `PATCH /:userId`'s `data` object similarly, plus accept `isActive: boolean` directly (this is the "employment status" toggle). Both handlers' response payload must include the same extended shape as the GET route above (id/fullName/jobTitle/roleId/roleName/phone/preferredLanguage/hiredAt/isActive/venueName) — include `location: { select: { name: true } }` in both handlers' Prisma calls to get `venueName`.

- [ ] **Step 4: Verify and live smoke-test**

Run: `npm run server:typecheck`
Then: create a test staff member with phone/preferredLanguage/hiredAt set, confirm the GET response includes all fields correctly including `venueName` matching the real seed location's name; PATCH `isActive: false` on them, confirm they still appear in the GET response (not silently hidden) with `isActive: false`; clean up.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations server/src/routes/staffDirectory.ts
git commit -m "feat: extend Staff Directory with phone, language, start date, employment status, venue"
```

---

### Task 6: Frontend API clients (identity, join, my-shifts, availability, policy documents, extended staff directory)

**Files:**
- Create: `src/api/identity.ts`
- Create: `src/api/join.ts`
- Create: `src/api/myShifts.ts`
- Create: `src/api/availability.ts`
- Create: `src/api/policyDocuments.ts`
- Modify: `src/api/staffDirectory.ts`

**Interfaces:**
- Produces: typed clients mirroring Tasks 3-5's routes exactly, including a `withAuth(token)` header-builder helper shared by `identity.ts`/`join.ts`/`myShifts.ts`/`availability.ts` consumers that need a Bearer token.
- Consumed by: Tasks 7-13.

- [ ] **Step 1: Cross-check every field against the real, already-committed route files from Tasks 3-5 before writing each client function** — do not assume the plan's snapshot is current if any earlier task's review found and fixed a deviation.

- [ ] **Step 2: `src/api/identity.ts`**

```typescript
import { ApiError } from './schedules';
export { ApiError };

export interface SessionUser {
  id: string;
  fullName: string;
  jobTitle: string | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

/** POST /api/identity/request-otp — login path. `devCode` is only ever present outside production. */
export async function requestLoginOtp(phone: string): Promise<{ expiresAt: string; devCode?: string }> {
  return request('/api/identity/request-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
}

/** POST /api/identity/verify-otp */
export async function verifyLoginOtp(phone: string, code: string): Promise<{ token: string; expiresAt: string; user: SessionUser }> {
  return request('/api/identity/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code }),
  });
}

const SESSION_STORAGE_KEY = 'shiftsync.session';

export interface StoredSession {
  token: string;
  expiresAt: string;
  user: SessionUser;
}

export function saveSession(session: StoredSession): void {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function loadSession(): StoredSession | null {
  const raw = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSession;
    if (new Date(parsed.expiresAt) < new Date()) {
      clearSession();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_STORAGE_KEY);
}
```

- [ ] **Step 3: `src/api/join.ts`**

```typescript
import { ApiError } from './schedules';
import type { SessionUser } from './identity';
export { ApiError };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function requestJoinOtp(phone: string): Promise<{ expiresAt: string; devCode?: string }> {
  return request('/api/join/request-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
}

export type JoinVerifyResult =
  | { pending: false; token: string; expiresAt: string; user: SessionUser }
  | { pending: true; joinRequestId: string };

export async function verifyJoinOtp(input: { locationId: string; phone: string; code: string; fullName?: string }): Promise<JoinVerifyResult> {
  return request('/api/join/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export interface JoinRequestDto {
  id: string;
  phone: string;
  fullName: string;
  createdAt: string;
}

export async function fetchPendingJoinRequests(locationId: string): Promise<JoinRequestDto[]> {
  const data = await request<{ requests: JoinRequestDto[] }>(`/api/join/${locationId}/pending`);
  return data.requests;
}

export async function decideJoinRequest(
  requestId: string,
  decision: 'approve' | 'decline',
  input?: { reviewedById?: string; jobTitle?: string },
): Promise<{ status: string; userId?: string }> {
  return request(`/api/join/${requestId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, ...input }),
  });
}
```

- [ ] **Step 4: `src/api/myShifts.ts`**

```typescript
import { ApiError } from './schedules';
export { ApiError };

export interface MyShiftEntry {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  roleName: string;
  status: 'DRAFT' | 'PUBLISHED' | 'COMPLETED' | 'CANCELLED';
}

export async function fetchMyShifts(token: string): Promise<{ pendingApproval: boolean; shifts: MyShiftEntry[] }> {
  const res = await fetch('/api/my-shifts', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as { pendingApproval: boolean; shifts: MyShiftEntry[] };
}
```

- [ ] **Step 5: `src/api/availability.ts`**

```typescript
import { ApiError } from './schedules';
export { ApiError };

export interface AvailabilityMarkDto {
  id: string;
  date: string;
  type: 'UNAVAILABLE' | 'PREFERRED_OFF';
  note: string | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function fetchAvailability(userId: string, weekStart: string): Promise<AvailabilityMarkDto[]> {
  const data = await request<{ marks: AvailabilityMarkDto[] }>(`/api/availability/${userId}?weekStart=${weekStart}`);
  return data.marks;
}

export async function setAvailability(input: { userId: string; date: string; type: 'UNAVAILABLE' | 'PREFERRED_OFF'; note?: string }): Promise<AvailabilityMarkDto> {
  return request('/api/availability', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function removeAvailability(id: string): Promise<void> {
  await request(`/api/availability/${id}`, { method: 'DELETE' });
}
```

- [ ] **Step 6: `src/api/policyDocuments.ts`**

```typescript
import { ApiError } from './schedules';
export { ApiError };

export interface PolicyDocumentDto {
  id: string;
  category: string;
  title: string;
  fileUrl: string;
  originalName: string | null;
  createdAt: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function fetchPolicyDocuments(locationId: string): Promise<PolicyDocumentDto[]> {
  const data = await request<{ documents: PolicyDocumentDto[] }>(`/api/policy-documents/${locationId}`);
  return data.documents;
}

export async function uploadPolicyDocument(input: { file: File; locationId: string; category: string; title: string; uploadedById?: string }): Promise<PolicyDocumentDto> {
  const form = new FormData();
  form.append('file', input.file);
  form.append('locationId', input.locationId);
  form.append('category', input.category);
  form.append('title', input.title);
  if (input.uploadedById) form.append('uploadedById', input.uploadedById);
  const data = await request<{ document: PolicyDocumentDto }>('/api/policy-documents/upload', { method: 'POST', body: form });
  return data.document;
}

export async function deletePolicyDocument(id: string): Promise<void> {
  await request(`/api/policy-documents/${id}`, { method: 'DELETE' });
}
```

- [ ] **Step 7: Extend `src/api/staffDirectory.ts`**

Update `StaffDirectoryEntry` and the add/update function signatures to match Task 5's real extended route exactly (phone, preferredLanguage, hiredAt, isActive, venueName) — read the real, already-committed `server/src/routes/staffDirectory.ts` first and mirror its exact response/request shapes field-for-field, following the same pattern already used by every other client file in this plan.

- [ ] **Step 8: Verify**

Run: `npm run typecheck`
Expected: fails only against `StaffDirectory.tsx` (still calling the old 3-field signature) — that's expected and resolved by Task 9.

- [ ] **Step 9: Commit**

```bash
git add src/api/identity.ts src/api/join.ts src/api/myShifts.ts src/api/availability.ts src/api/policyDocuments.ts src/api/staffDirectory.ts
git commit -m "feat: add identity/join/my-shifts/availability/policy-document clients, extend staff-directory client"
```

---

### Task 7: IdentityContext + Join flow UI

**Files:**
- Create: `src/state/IdentityContext.tsx`
- Create: `src/components/JoinFlow.tsx`
- Create: `src/routes/JoinRoute.tsx`
- Modify: `src/router.tsx` (add `/join`)

**Interfaces:**
- Produces: `IdentityProvider`/`useIdentity()` exposing `{ session, login, logout }`; `JoinFlow` component (phone → OTP → session-or-pending); `/join` route.

- [ ] **Step 1: `src/state/IdentityContext.tsx`**

```tsx
import { createContext, useContext, useState, type ReactNode } from 'react';
import { loadSession, saveSession, clearSession, type StoredSession } from '../api/identity';

interface IdentityValue {
  session: StoredSession | null;
  login: (session: StoredSession) => void;
  logout: () => void;
}

const IdentityCtx = createContext<IdentityValue | null>(null);

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(() => loadSession());

  const login = (next: StoredSession) => {
    saveSession(next);
    setSession(next);
  };
  const logout = () => {
    clearSession();
    setSession(null);
  };

  return <IdentityCtx.Provider value={{ session, login, logout }}>{children}</IdentityCtx.Provider>;
}

export function useIdentity(): IdentityValue {
  const ctx = useContext(IdentityCtx);
  if (!ctx) throw new Error('useIdentity must be used within IdentityProvider');
  return ctx;
}
```

Mount `IdentityProvider` in `src/main.tsx` (or wherever `AppStateProvider` is currently mounted — nest it alongside, read the real current file first) so `useIdentity()` is available app-wide, same as `useAppState()`.

- [ ] **Step 2: `src/components/JoinFlow.tsx`**

A 3-step phone → OTP → result flow (real component, real state machine — follow this codebase's established multi-step pattern, e.g. `ShiftUpload.tsx`'s phase-based state):

```tsx
import { useState } from 'react';
import { ApiError } from '../api/join';
import { requestJoinOtp, verifyJoinOtp } from '../api/join';
import { useIdentity } from '../state/IdentityContext';

type Phase = 'phone' | 'otp' | 'pending' | 'error';

export default function JoinFlow({ locationId }: { locationId: string }) {
  const { login } = useIdentity();
  const [phase, setPhase] = useState<Phase>('phone');
  const [phone, setPhone] = useState('');
  const [fullName, setFullName] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleRequestOtp = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await requestJoinOtp(phone);
      setDevCode(res.devCode ?? null);
      setPhase('otp');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not request a code.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerify = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await verifyJoinOtp({ locationId, phone, code, fullName: fullName.trim() || undefined });
      if (result.pending) {
        setPhase('pending');
      } else {
        login({ token: result.token, expiresAt: result.expiresAt, user: result.user });
        window.location.href = '/my-shifts';
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify that code.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel mx-auto max-w-md p-6">
      <h2 className="text-lg font-semibold">Join ShiftSync</h2>

      {error && (
        <div className="error-block mt-3" role="alert">
          <p>{error}</p>
        </div>
      )}

      {phase === 'phone' && (
        <div className="mt-4 space-y-3">
          <input
            className="staff-directory-input w-full"
            placeholder="Phone number"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <button className="btn btn-primary w-full" onClick={() => void handleRequestOtp()} disabled={submitting || !phone.trim()}>
            {submitting ? 'Sending…' : 'Send code'}
          </button>
        </div>
      )}

      {phase === 'otp' && (
        <div className="mt-4 space-y-3">
          {devCode && (
            <p className="hint">Dev mode — your code is <span className="font-mono font-semibold">{devCode}</span> (no SMS is sent in this environment).</p>
          )}
          <input
            className="staff-directory-input w-full"
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <input
            className="staff-directory-input w-full"
            placeholder="Full name (if this is your first time)"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
          />
          <button className="btn btn-primary w-full" onClick={() => void handleVerify()} disabled={submitting || !code.trim()}>
            {submitting ? 'Verifying…' : 'Verify & continue'}
          </button>
        </div>
      )}

      {phase === 'pending' && (
        <div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
          Thanks — your request has been submitted for review. A manager will approve your account shortly.
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: `src/routes/JoinRoute.tsx`**

```tsx
import JoinFlow from '../components/JoinFlow';

export default function JoinContent() {
  return <JoinFlow locationId="seed-location" />;
}
```

- [ ] **Step 4: Add the route**

In `src/router.tsx`, add a child route for `/join` with `element: <JoinContent />` and `handle: { title: 'Join' }` — read the current real file first (per this plan's established caution about files touched by multiple tasks) and follow its existing route-declaration pattern exactly.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add src/state/IdentityContext.tsx src/components/JoinFlow.tsx src/routes/JoinRoute.tsx src/router.tsx src/main.tsx
git commit -m "feat: add IdentityContext and the Join self-registration flow"
```

---

### Task 8: My Shifts + Profile

**Files:**
- Create: `src/routes/MyShiftsRoute.tsx`
- Modify: `src/routes/ProfileRoute.tsx`
- Modify: `src/router.tsx` (add `/my-shifts`)

**Interfaces:**
- Produces: a real My Shifts staff-home screen (pending-approval banner, next-5-shifts, reused Announcements/Shoutouts feed components) and a real Profile screen (account card + notification preferences), replacing the 1-line placeholder.

- [ ] **Step 1: Read the current real `Announcements`/`Shoutouts` components** (mounted today on `HomeRoute.tsx`) to reuse them verbatim on My Shifts, per the directive's explicit "announcements/shoutouts feed" requirement — do not build a second feed implementation.

- [ ] **Step 2: `src/routes/MyShiftsRoute.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useIdentity } from '../state/IdentityContext';
import { fetchMyShifts, ApiError, type MyShiftEntry } from '../api/myShifts';
import Announcements from '../components/shiftsync/Announcements';
import Shoutouts from '../components/shiftsync/Shoutouts';

export default function MyShiftsContent() {
  const { session } = useIdentity();
  const [pendingApproval, setPendingApproval] = useState(false);
  const [shifts, setShifts] = useState<MyShiftEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session) {
      setLoading(false);
      return;
    }
    fetchMyShifts(session.token)
      .then((data) => {
        setPendingApproval(data.pendingApproval);
        setShifts(data.shifts);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load your shifts.'))
      .finally(() => setLoading(false));
  }, [session]);

  if (!session) {
    return (
      <div className="status-block">
        <p>You're not signed in. Head to Join or log in with your phone number to see your shifts.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <h2 className="section-title">Welcome back, {session.user.fullName}</h2>

      {pendingApproval && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
          Your account is still pending manager approval — some things may look incomplete until then.
        </div>
      )}

      {error && (
        <div className="error-block" role="alert">
          <p>{error}</p>
        </div>
      )}

      <section className="panel p-5">
        <h3 className="text-sm font-semibold">Your next shifts</h3>
        {loading ? (
          <p className="hint">Loading…</p>
        ) : shifts.length === 0 ? (
          <p className="hint">No upcoming shifts scheduled yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {shifts.map((s) => (
              <li key={s.id} className="rounded-lg border border-border px-3 py-2 text-sm">
                <span className="font-medium">{s.date}</span> · {s.roleName} ·{' '}
                {new Date(s.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–
                {new Date(s.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Announcements locationId="seed-location" />
      <Shoutouts locationId="seed-location" />
    </div>
  );
}
```

(Verify `Announcements`/`Shoutouts`'s real prop names before finalizing — read the current real components, since this snippet's props are a best guess pending that read.)

- [ ] **Step 3: Real `ProfileRoute.tsx`**

```tsx
import { useIdentity } from '../state/IdentityContext';

export default function ProfileContent() {
  const { session, logout } = useIdentity();

  if (!session) {
    return <p className="panel p-5 text-sm text-muted-foreground">Sign in via Join to see your profile.</p>;
  }

  return (
    <div className="space-y-5">
      <section className="panel p-5">
        <p className="eyebrow">Account</p>
        <h2 className="text-lg font-semibold">{session.user.fullName}</h2>
        {session.user.jobTitle && <p className="text-sm text-muted-foreground">{session.user.jobTitle}</p>}
        <button className="btn btn-ghost mt-4" onClick={logout}>
          Sign out
        </button>
      </section>

      <section className="panel p-5">
        <p className="eyebrow">Notification preferences</p>
        <p className="hint mt-2">
          No real push/SMS notification integration exists in this app yet (consistent with every other "notify" feature
          here) — this section is a placeholder for when one is added.
        </p>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Add the `/my-shifts` route**

In `src/router.tsx`, add a child route for `/my-shifts` with `element: <MyShiftsContent />` and `handle: { title: 'My Shifts' }`.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add src/routes/MyShiftsRoute.tsx src/routes/ProfileRoute.tsx src/router.tsx
git commit -m "feat: build My Shifts and a real Profile screen"
```

---

### Task 9: Pending Approvals + extended Staff Directory UI

**Files:**
- Create: `src/components/PendingApprovals.tsx`
- Modify: `src/components/StaffDirectory.tsx`
- Modify: `src/routes/PeopleRoute.tsx`

**Interfaces:**
- Produces: `PendingApprovals` component (approve/decline `JoinRequest` rows, styled after `ApprovalsPanel.tsx`'s pending/decided pattern); `StaffDirectory.tsx` gains editable phone/language/start-date/employment-status fields and a read-only venue column.

- [ ] **Step 1: `src/components/PendingApprovals.tsx`**

Follow `ApprovalsPanel.tsx`'s collapsible-panel + list styling exactly (read it first — already quoted in full in this plan's recon), adapted for `JoinRequest` instead of `ShiftSwapRequest`:

```tsx
import { useEffect, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { fetchPendingJoinRequests, decideJoinRequest, ApiError, type JoinRequestDto } from '../api/join';

export default function PendingApprovals({ locationId }: { locationId: string }) {
  const [requests, setRequests] = useState<JoinRequestDto[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const load = () => {
    fetchPendingJoinRequests(locationId)
      .then(setRequests)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load pending approvals.'));
  };

  useEffect(() => {
    load();
  }, [locationId]);

  const handleDecide = async (id: string, decision: 'approve' | 'decline') => {
    setDecidingId(id);
    try {
      await decideJoinRequest(id, decision);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not process that request.');
    } finally {
      setDecidingId(null);
    }
  };

  return (
    <section className="panel animate-rise overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-surface-raised/40"
      >
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Needs review</p>
          <h2 className="text-base font-semibold tracking-tight">Pending Approvals</h2>
        </div>
        {requests.length > 0 && (
          <span className="rounded-full border border-warning/30 bg-warning/10 px-2.5 py-1 text-[11px] font-medium text-warning">
            {requests.length}
          </span>
        )}
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-300', open && 'rotate-180')} />
      </button>

      {open && (
        <>
          {error && (
            <div className="error-block mx-4 mb-2" role="alert">
              <p>{error}</p>
            </div>
          )}
          {requests.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No join requests waiting for review.</p>
          ) : (
            <ul className="divide-y divide-border">
              {requests.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{r.fullName}</p>
                    <p className="text-xs text-muted-foreground">{r.phone}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => void handleDecide(r.id, 'approve')}
                      disabled={decidingId === r.id}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground"
                    >
                      <Check className="h-3.5 w-3.5" /> Approve
                    </button>
                    <button
                      onClick={() => void handleDecide(r.id, 'decline')}
                      disabled={decidingId === r.id}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium hover:border-destructive/40 hover:text-destructive"
                    >
                      <X className="h-3.5 w-3.5" /> Decline
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Extend `StaffDirectory.tsx`**

Read the current real file (quoted in full elsewhere in this plan's recon) and add: a `phone` input, a `preferredLanguage` input with a `<datalist>` of previously-seen languages (mirroring the 86 List's station-autocomplete pattern from the Floor Plan phase — reuse that exact idea, not a new pattern), a `hiredAt` date input, an `isActive` toggle/checkbox (employment status), and a read-only `venueName` column in the table. Wire all of these through `updateStaffMember`'s extended signature from Task 6. Follow the existing blur-to-save pattern already used for `jobTitle` for each new editable field.

- [ ] **Step 3: Mount `PendingApprovals` on `PeopleRoute.tsx`**

```tsx
import StaffDirectory from '../components/StaffDirectory';
import PendingApprovals from '../components/PendingApprovals';
import { useAppState } from '../state/AppStateContext';

export default function PeopleContent() {
  const { setStaffDirectory } = useAppState();
  return (
    <div className="space-y-5">
      <PendingApprovals locationId="seed-location" />
      <StaffDirectory locationId="seed-location" onChanged={setStaffDirectory} />
    </div>
  );
}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add src/components/PendingApprovals.tsx src/components/StaffDirectory.tsx src/routes/PeopleRoute.tsx
git commit -m "feat: add Pending Approvals and extend Staff Directory with the new People fields"
```

---

### Task 10: Training & Policy document hub UI

**Files:**
- Create: `src/components/PolicyDocuments.tsx`
- Modify: `src/routes/PeopleRoute.tsx`

**Interfaces:**
- Produces: `PolicyDocuments` component — upload form (category + title + file), category-grouped list with download links, delete action.

- [ ] **Step 1: `src/components/PolicyDocuments.tsx`**

Follow the exact grouped-list pattern already established by `EightySixBoard.tsx` in the Floor Plan phase (group by a free-text field, `<datalist>` autocomplete for previously-used categories) — reuse that pattern, don't invent a new one:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, Trash2, Upload } from 'lucide-react';
import { fetchPolicyDocuments, uploadPolicyDocument, deletePolicyDocument, ApiError, type PolicyDocumentDto } from '../api/policyDocuments';

export default function PolicyDocuments({ locationId }: { locationId: string }) {
  const [docs, setDocs] = useState<PolicyDocumentDto[]>([]);
  const [category, setCategory] = useState('');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(() => {
    fetchPolicyDocuments(locationId)
      .then(setDocs)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load documents.'));
  }, [locationId]);

  useEffect(() => {
    load();
  }, [load]);

  const knownCategories = useMemo(() => [...new Set(docs.map((d) => d.category))].sort(), [docs]);
  const grouped = useMemo(() => {
    const byCategory = new Map<string, PolicyDocumentDto[]>();
    for (const d of docs) {
      const bucket = byCategory.get(d.category) ?? [];
      bucket.push(d);
      byCategory.set(d.category, bucket);
    }
    return [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [docs]);

  const handleUpload = async () => {
    if (!file || !category.trim() || !title.trim()) return;
    setUploading(true);
    setError(null);
    try {
      await uploadPolicyDocument({ file, locationId, category: category.trim(), title: title.trim() });
      setFile(null);
      setCategory('');
      setTitle('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not upload that document.');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deletePolicyDocument(id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete that document.');
    }
  };

  return (
    <section className="panel p-5">
      <h2 className="text-base font-semibold">Training &amp; Policy Documents</h2>

      {error && (
        <div className="error-block mt-3" role="alert">
          <p>{error}</p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          className="staff-directory-input"
          list="policy-doc-categories"
          placeholder="Category (e.g. Onboarding, Food Safety)"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <datalist id="policy-doc-categories">
          {knownCategories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <input
          className="staff-directory-input"
          placeholder="Document title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button
          className="btn btn-primary"
          onClick={() => void handleUpload()}
          disabled={uploading || !file || !category.trim() || !title.trim()}
        >
          <Upload className="h-4 w-4" /> Upload
        </button>
      </div>

      {grouped.length === 0 ? (
        <p className="hint mt-4">No documents uploaded yet.</p>
      ) : (
        <div className="mt-4 space-y-4">
          {grouped.map(([cat, catDocs]) => (
            <div key={cat}>
              <p className="eyebrow">{cat}</p>
              <ul className="mt-1.5 space-y-1.5">
                {catDocs.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                    <a href={d.fileUrl} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-2 hover:text-accent">
                      <FileText className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{d.title}</span>
                    </a>
                    <button onClick={() => void handleDelete(d.id)} aria-label={`Delete ${d.title}`} className="shrink-0 text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Mount on `PeopleRoute.tsx`**

Read the current real file (already modified by Task 9) and add `<PolicyDocuments locationId="seed-location" />` alongside `PendingApprovals`/`StaffDirectory`.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add src/components/PolicyDocuments.tsx src/routes/PeopleRoute.tsx
git commit -m "feat: build the Training and Policy document hub"
```

---

### Task 11: Self-service availability marking + RotaBuilder informational warning

**Files:**
- Modify: `src/routes/MyShiftsRoute.tsx` (or a small new sub-component) — availability marking UI
- Modify: `src/components/shiftsync/RotaBuilder.tsx`

**Interfaces:**
- Produces: a real UI for a staff member to mark a day unavailable/preferred-off (from My Shifts, since that's the identity-gated staff-facing screen); RotaBuilder shows a non-blocking informational badge when a manager assigns someone to a day they've marked.

- [ ] **Step 1: Add an availability-marking widget to `MyShiftsRoute.tsx`**

Read the current real file (built in Task 8) and add a small week-view widget: 7 day buttons, each toggleable between unmarked/unavailable/preferred-off (cycling through the 3 states on click), calling `setAvailability`/`removeAvailability` from Task 6's client, scoped to `session.user.id` and the real current week (reuse `currentWeekStart()`/`weekDates()` from `src/engine/weekStart.ts`/`rosterView.ts`, already established elsewhere in this app — don't reinvent week math).

- [ ] **Step 2: RotaBuilder informational warning**

Read the current real `RotaBuilder.tsx` (already a large, several-times-modified file from the Scheduling phase). Add: a fetch of availability marks for the visible week (a new small effect, keyed on `weekStart`, calling `fetchAvailability` per assigned staff member — or, more efficiently, once for all staff via a small addition to `GET /api/availability/:userId` — use your judgement on whether a batched "all staff for this week" backend endpoint is warranted here versus N per-person calls; if the grid can have many staff, prefer one batched call and note if that requires a small backend addition beyond what Task 4 built, ruling on it yourself and documenting the ruling rather than silently expanding scope without a note). Render a small, clearly non-blocking badge/icon on a cell where the assigned person has marked that day unavailable or preferred-off — an informational indicator only, never disabling the drag/assign/save actions. This directly implements the directive's explicit "informational warning... not a hard compliance block" instruction — do not gate shift creation or assignment on this data in any way.

- [ ] **Step 3: Verify and live smoke-test**

Run: `npm run typecheck && npm run build`
Then, with a real session and a real staff member: mark a real day unavailable via the new widget, confirm it persists via `GET /api/availability`; open RotaBuilder for that week, confirm the informational badge appears on that person's cell for that day, and confirm assigning/moving a shift onto that exact cell still works completely normally (no block, no confirmation dialog forcing an override) — this is the one behavior this task must never regress.

- [ ] **Step 4: Commit**

```bash
git add src/routes/MyShiftsRoute.tsx src/components/shiftsync/RotaBuilder.tsx
git commit -m "feat: add self-service availability marking and an informational RotaBuilder warning"
```

---

### Task 12: Onboarding wizard

**Files:**
- Create: `src/components/OnboardingWizard.tsx`
- Create: `src/routes/OnboardingRoute.tsx`
- Modify: `src/router.tsx` (add `/onboarding`)
- Create: `server/src/lib/qrCode.ts`
- Modify: `server/package.json`/`package.json` (add `qrcode` dependency)
- Create: `server/src/routes/onboarding.ts` (invite-link/QR endpoint only — roster import reuses the existing `schedules.ts` endpoints untouched)
- Modify: `server/src/app.ts` (mount)

**Interfaces:**
- Produces: a 4-step wizard (venue → roster-upload [reusing `ShiftUpload`] → review → invite), plus a tiny new backend endpoint that mints an invite link and its QR code for a given location.

- [ ] **Step 1: Install `qrcode`**

Run: `npm install qrcode` (root, since this is used server-side and the server shares the root `node_modules` in this repo's existing structure — confirm this matches how `multer`/`xlsx`/other server-only deps were added in earlier phases before assuming; if server deps are actually isolated, install into `server/` instead). Also run `npm install --save-dev @types/qrcode` if a separate types package is needed (check whether `qrcode` ships its own types first).

- [ ] **Step 2: `server/src/lib/qrCode.ts`**

```typescript
import QRCode from 'qrcode';

/** Renders a URL as a QR code data-URL PNG, ready to drop straight into an <img src>. */
export async function generateQrDataUrl(url: string): Promise<string> {
  return QRCode.toDataURL(url, { margin: 1, width: 320 });
}
```

- [ ] **Step 3: `server/src/routes/onboarding.ts`**

```typescript
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { generateQrDataUrl } from '../lib/qrCode.js';

export const onboardingRouter = Router();

/**
 * GET /api/onboarding/:locationId/invite
 * Mints the venue's Join-flow invite link and its QR code. The link itself
 * needs no token/expiry — Join's own phone+OTP verification is the real
 * gate; this is just a convenient, shareable pointer to /join.
 */
onboardingRouter.get('/:locationId/invite', async (req, res) => {
  try {
    const { locationId } = req.params;
    const location = await prisma.location.findUnique({ where: { id: locationId } });
    if (!location) return res.status(404).json({ error: `Location "${locationId}" not found.` });

    const baseUrl = String(req.query.baseUrl ?? `${req.protocol}://${req.get('host')}`);
    const inviteUrl = `${baseUrl}/join?location=${locationId}`;
    const qrDataUrl = await generateQrDataUrl(inviteUrl);
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`Join ${location.name} on ShiftSync: ${inviteUrl}`)}`;

    return res.status(200).json({ inviteUrl, qrDataUrl, whatsappUrl });
  } catch (err) {
    console.error('[onboarding.invite] failed', err);
    return res.status(500).json({ error: 'Unexpected error while generating the invite link.' });
  }
});
```

- [ ] **Step 4: Mount it**

In `server/src/app.ts`:

```typescript
import { onboardingRouter } from './routes/onboarding.js';
// ...
  app.use('/api/onboarding', onboardingRouter);
```

- [ ] **Step 5: `src/components/OnboardingWizard.tsx`**

A 4-step wizard reusing the real `ShiftUpload` component for its roster step verbatim (per the directive's explicit instruction not to rebuild parsing as a mock):

```tsx
import { useState } from 'react';
import ShiftUpload from './ShiftUpload';

type Step = 'venue' | 'roster' | 'review' | 'invite';

export default function OnboardingWizard({ locationId }: { locationId: string }) {
  const [step, setStep] = useState<Step>('venue');
  const [invite, setInvite] = useState<{ inviteUrl: string; qrDataUrl: string; whatsappUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadInvite = async () => {
    try {
      const res = await fetch(`/api/onboarding/${locationId}/invite`);
      if (!res.ok) throw new Error('Could not generate the invite link.');
      const data = await res.json();
      setInvite(data);
      setStep('invite');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate the invite link.');
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex gap-2">
        {(['venue', 'roster', 'review', 'invite'] as const).map((s) => (
          <span
            key={s}
            className={`rounded-full px-3 py-1 text-xs font-medium ${step === s ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground'}`}
          >
            {s}
          </span>
        ))}
      </div>

      {error && (
        <div className="error-block" role="alert">
          <p>{error}</p>
        </div>
      )}

      {step === 'venue' && (
        <section className="panel p-5">
          <p className="hint">Confirm your venue details, then move on to importing your existing roster.</p>
          <button className="btn btn-primary mt-4" onClick={() => setStep('roster')}>
            Continue
          </button>
        </section>
      )}

      {step === 'roster' && (
        <section className="panel p-5">
          <p className="hint mb-3">
            Upload your existing roster (Excel, CSV, PDF, or a photo) — this uses the same real parser as the
            Scheduling page's upload tool, not a separate mock.
          </p>
          <ShiftUpload locationId={locationId} onCommitted={() => setStep('review')} />
        </section>
      )}

      {step === 'review' && (
        <section className="panel p-5">
          <p className="hint">Your roster has been imported. When you're ready, generate an invite link for your team to join.</p>
          <button className="btn btn-primary mt-4" onClick={() => void loadInvite()}>
            Generate invite
          </button>
        </section>
      )}

      {step === 'invite' && invite && (
        <section className="panel p-5 text-center">
          <img src={invite.qrDataUrl} alt="Invite QR code" className="mx-auto h-48 w-48" />
          <p className="mt-3 break-all text-sm text-muted-foreground">{invite.inviteUrl}</p>
          <a href={invite.whatsappUrl} target="_blank" rel="noreferrer" className="btn btn-primary mt-4 inline-flex">
            Share via WhatsApp
          </a>
        </section>
      )}
    </div>
  );
}
```

(Verify `ShiftUpload`'s real `onCommitted` prop signature before finalizing — read the current real component, since this snippet's usage is a best guess pending that read, per this plan's established caution.)

- [ ] **Step 6: `src/routes/OnboardingRoute.tsx`** + router entry

```tsx
import OnboardingWizard from '../components/OnboardingWizard';

export default function OnboardingContent() {
  return <OnboardingWizard locationId="seed-location" />;
}
```

Add `/onboarding` to `src/router.tsx` the same way as Tasks 7-8's new routes.

- [ ] **Step 7: Verify and live smoke-test**

Run: `npm run typecheck && npm run server:typecheck && npm run build`
Then: call the real invite endpoint for the seed location, confirm a real QR data-URL and a well-formed WhatsApp share link are returned; manually decode the QR (any phone camera or online decoder) and confirm it points at a real, reachable `/join?location=...` URL.

- [ ] **Step 8: Commit**

```bash
git add src/components/OnboardingWizard.tsx src/routes/OnboardingRoute.tsx src/router.tsx server/src/lib/qrCode.ts server/src/routes/onboarding.ts server/src/app.ts package.json package-lock.json
git commit -m "feat: build the onboarding wizard (venue -> roster -> review -> QR/WhatsApp invite)"
```

---

### Task 13: Full verification, live end-to-end check, MEMORY.md

**Files:**
- Modify: `MEMORY.md`

**Interfaces:** none new — this task is the acceptance gate for the whole phase.

- [ ] **Step 1: Full verification pass**

Run, in order: `npm run server:typecheck`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `npm run test:server`. All must succeed.

- [ ] **Step 2: Live end-to-end check**

With the real server running, exercise the full lifecycle against real seed data and clean up every row created:
- Set a real `phone` on a real seed user (via a throwaway script if none has one), request+verify a login OTP for it, confirm a real session is issued and resolves to the right user.
- Submit a Join request for a phone that matches no one, with a full name, confirm a real `PENDING` `JoinRequest` appears in Pending Approvals; approve it and confirm a real new, active `User` is created and linked; repeat for a decline.
- Extend a real staff member's directory fields (phone/language/start-date/employment-status) and confirm they round-trip through the extended Staff Directory UI/API, including confirming a set-to-inactive staff member still appears in the list (not silently hidden).
- Upload a real test PDF to the Training & Policy hub, confirm it lists grouped by category and is downloadable, delete it.
- Mark a real day unavailable for a real staff member, confirm it shows as an informational badge in RotaBuilder without blocking assignment to that day.
- Generate a real onboarding invite link + QR for the seed location, confirm the link is well-formed and reachable.
- State plainly in your report what was NOT verified: any visual/interactive behavior (the wizard's step transitions, the QR's actual scannability from a physical phone, RotaBuilder's badge placement) needs a human with a real browser and device — no such tool exists in this environment.

- [ ] **Step 3: Update `MEMORY.md`**

Check off this phase's items under `## Completed Core Components`; reuse the existing `## Next Sprint Goals` heading (do not create a duplicate — this exact mistake was made once already in an earlier phase and explicitly should not be repeated). Note for whoever picks up Confirm Roster next: a real (if lightweight) identity/session system now exists — `Session`/`OtpCode` — and any future staff-facing screen should use `requireSession`/`useIdentity()` rather than inventing a second identity concept.

- [ ] **Step 4: Commit**

```bash
git add MEMORY.md
git commit -m "docs: record People + Identity/Onboarding/Join phase completion"
```

---

## Self-Review

**Spec coverage:**
- Staff Directory field extensions (venue, language, phone, start date, employment status; no contract hours) → Tasks 1, 5, 6, 9. Venue/employment-status/start-date judgment calls documented in Global Constraints, not silently guessed. ✅
- Training & Policy document hub (upload/download PDFs by category) → Tasks 1, 4, 6, 10. ✅
- Pending Approvals, built after Join → enforced by task ORDER (Task 3 builds Join before Task 9 builds Pending Approvals' UI; Task 3 itself builds both Join's backend and Pending Approvals' backend together, since the directive's dependency is conceptual/product-sequencing, not a hard technical requirement that they be different tasks). ✅
- Lightweight phone+OTP identity, not full account/password → Tasks 1, 2, 3. No password field, no email/OAuth added anywhere. ✅
- My Shifts (pending-approval banner, next-5-shifts, announcements/shoutouts feed) and Profile (account card, notification preferences) → Task 8, built on the real identity from Tasks 2-3. ✅
- Self-service availability marking, informational only → Task 11, explicitly verified in its own smoke-test step that assignment is never blocked. ✅
- Onboarding wizard reusing real upload/confirm, ending in QR + WhatsApp → Task 12, `ShiftUpload` reused verbatim, no second parser built. ✅
- "Get Started" checklist skipped → satisfied by omission; no task in this plan builds anything resembling it. ✅
- Join: phone+OTP self-registration, auto-match by phone digits, fallback to Pending Approvals → Task 3's `join.ts` route, `phoneDigits()` normalization shared with the login path. ✅

**Placeholder scan:** Task 11's batched-vs-per-person availability fetch for RotaBuilder is the one place this plan explicitly asks the implementer to make and document a judgment call rather than guessing at a backend shape not yet built — flagged, not silently deferred.

**Type consistency:** `SessionUser`/`StoredSession` flow identically from Task 3's routes → Task 6's client → Tasks 7-8's consumers. `JoinRequestDto` flows identically from Task 3 → Task 6 → Task 9.
