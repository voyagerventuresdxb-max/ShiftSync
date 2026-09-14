# AI Voice: Post Announcement + Post Shoutout (v1 slice)

## 1. Context

This is the fifth and, per the current roadmap, last planned voice slice — built on top of whatever Slice 3 (`PUBLISH_ROTA`/`APPLY_ROTA_TEMPLATE`) lands on. It adds two new manager-only intents: `POST_ANNOUNCEMENT` and `POST_SHOUTOUT`.

Every prior voice intent (through Slice 3) resolves the transcript into structured *references* — ids picked from a list handed to the model in context (`roleId`, `staffId`, `templateId`, ...), dates, times. The confirm-preview is always a model-composed `summary` sentence *describing* an action, because the action's real content (a shift's time range, a swap's target) is small and fully captured by those structured fields.

This slice is qualitatively different: the transcript's free-text content **is** the payload. There is no structured field to fall back on — the announcement body or the shoutout note is exactly what a real person will read on the Home feed. The rest of this spec resolves how that changes the pipeline.

### 1.1 What already exists

Confirmed by direct source inspection (`server/src/routes/announcements.ts`, `server/src/routes/shoutouts.ts`, `prisma/schema.prisma`):

- **`Announcement`**: venue-wide broadcast. `{ id, locationId, authorId?, body, createdAt, editedAt? }`. `body` is `@db.Text` — no length constraint. Creating one fans out `notifyUsersBatched` to every active user at the location except the author. Has PATCH (edit) and DELETE routes — mutable.
- **`Shoutout`**: targets one specific staff member. `{ id, locationId, employeeId, authorId?, shiftSnapshot?, note, createdAt }`. `employeeId` (required FK to `User`, relation `ShoutoutRecipient`) plays the same "who this is about" role `REQUEST_SWAP.targetUserId` already plays. `note` is `@db.Text`, no length constraint. Creating one notifies only `employeeId` (skipped if self-tagged). No PATCH/DELETE — immutable once posted.
- **Neither mutator is extracted** — both are fully inline in their route handlers, in `server/src/lib/actions/`-adjacent style but not actually in that directory.
- **Neither POST route requires a session at all** — not `requireSession`, not `requireManager`. This is not a role-scoping gap like the ones Slice 3's routes had before their 2026-09-05 fix (see `rotaTemplates.ts`'s comment history) — it's a complete absence of authentication. Any unauthenticated request can currently broadcast an announcement to a venue or post a "shoutout" attributed to an arbitrary `authorId` for an arbitrary `employeeId`.
- **No length cap, no content moderation, no rate limiting exists anywhere on either path** — confirmed by full-repo search. The manual UI (`Announcements.tsx`, `Shoutouts.tsx`) uses a bare `<textarea>` with no `maxLength`, and posts immediately on click with no confirmation step. The only rate limiters in this codebase (`transcribeRateLimiter`, `parseIntentRateLimiter`, `rosterUploadRateLimiter`, all in `server/src/middleware/rateLimit.ts`) gate AI-provider-cost routes, not these.

This means the task's third design question — "what existing moderation/length limits must voice inherit" — has a factual answer of **none exist to inherit**. §2.3 below treats that as a real gap this slice should close, not silently ship around, since voice materially lowers the effort to produce spam/abusive content compared to typing in the manual UI.

## 2. Decision (already made — this spec documents it, not re-derives it)

### 2.1 — The model performs light, disfluency-only cleanup; the cleaned text becomes the ONLY value that ever exists downstream — never re-derived, never re-cleaned.

Two options were weighed: (a) post the raw transcript verbatim, filler words and all; (b) let the model clean it up for readability. Chosen: **(b), with a hard constraint that closes the exact gap the task called out** — the confirm-preview must show the string that will actually post, not a promise about a future cleanup step.

Mechanically, this is simpler than it sounds precisely *because* of how this pipeline already works: every existing intent field (`roleId`, `shiftId`, `templateName`, ...) is already round-tripped byte-for-byte from `/parse-intent`'s response, through the client, back to `/execute`'s request body, with zero server-side regeneration in between. The new `content` field (§2.2) just needs to follow that exact same discipline. So the actual guarantee is: **whatever string sits in `intent.content` when `/parse-intent` returns it is character-for-character identical to the string `POST_ANNOUNCEMENT`/`POST_SHOUTOUT`'s `/execute` case passes into `createAnnouncement`/`createShoutout`.** No cleanup, paraphrasing, or regeneration happens a second time at execute — that would let posted content silently diverge from what the caller confirmed, which is the one thing this intent absolutely cannot do.

The model's cleanup instruction (new prompt text, §7.3) is scoped narrowly: strip filler words ("um", "uh"), false starts, and fix obvious punctuation/capitalization — never paraphrase, shorten, summarize, or add content. This is the same class of instruction Gemini already follows for STT-adjacent cleanup elsewhere in this pipeline (the `/transcribe` endpoint's vocabulary-hint mechanism exists for accuracy, not rewriting), just applied to a field instead of the whole transcript.

**Frontend implication (not just backend wiring):** every prior intent's confirm sheet renders `intent.summary` as one line of prose. That pattern is wrong for this intent — the task requires the content shown "exactly as it will be posted," and folding free-form long-form text into a single "plain English sentence describing what will happen" risks the model paraphrasing it while composing that sentence (exactly the failure this spec exists to prevent). So `summary` for these two intents is deliberately kept short and generic ("Post this to the venue announcement board", "Give {name} a shoutout with this note") — a framing line, not a content carrier — and the actual content renders from `intent.content` in its own clearly-delimited block (a quoted/bordered text area in the confirm sheet, §8), never interpolated into `summary`. This is a genuine (small) frontend component change, not purely backend wiring — flagged explicitly since every prior slice's frontend change was "the existing sheet already handles this."

### 2.2 — Extraction target: one new file, `server/src/lib/actions/communicationActions.ts`, both mutators.

`shiftActions.ts`↔`shifts.ts`, `swapActions.ts`↔`swapRequests.ts` are 1:1 with their REST route file. `rotaActions.ts` (Slice 3) already breaks that 1:1 pattern deliberately, combining `shifts.ts`'s publish and `rotaTemplates.ts`'s apply under one topic ("rota") since both intents in that slice are conceptually one feature area. The same reasoning applies here: `Announcement` and `Shoutout` are two distinct models with two distinct REST routes, but both exist for exactly one purpose — posting to the Home feed — and this slice adds voice support for both together. One file, two exported functions (`createAnnouncement`, `createShoutout`), same as `rotaActions.ts` exports `publishRota`+`applyRotaTemplate`.

Following Slice 3's validation-lives-in-the-action precedent (its spec §2.3, chosen specifically to avoid parallel validation logic across the REST route and voice's `/execute`) rather than the older `sectionActions.ts`/`swapActions.ts` validate-in-caller split:

```ts
// server/src/lib/actions/communicationActions.ts

export type CreateAnnouncementResult =
  | { result: 'ok'; announcement: { id: string; body: string; authorId: string | null; authorName: string | null; createdAt: Date } }
  | { result: 'location_not_found'; message: string }
  | { result: 'author_not_found'; message: string }
  | { result: 'too_long'; message: string }
  | { result: 'rate_limited'; message: string };

export async function createAnnouncement(input: {
  locationId: string;
  authorId: string | null;
  body: string;
}): Promise<CreateAnnouncementResult> { /* ... */ }

export type CreateShoutoutResult =
  | { result: 'ok'; shoutout: { id: string; employeeId: string; employeeName: string; authorId: string | null; authorName: string | null; note: string; createdAt: Date } }
  | { result: 'employee_not_found'; message: string }
  | { result: 'author_not_found'; message: string }
  | { result: 'too_long'; message: string }
  | { result: 'rate_limited'; message: string };

export async function createShoutout(input: {
  locationId: string;
  employeeId: string;
  authorId: string | null;
  shiftSnapshot: string | null;
  note: string;
}): Promise<CreateShoutoutResult> { /* ... */ }
```

Both REST routes (`announcements.ts`, `shoutouts.ts`) become thin wrappers, exactly like Slice 3's `shifts.ts`/`rotaTemplates.ts` did. Notification fan-out (`notifyUsersBatched`/`notifyUser`, already existing in `lib/push.ts`) stays a caller-side, post-write, `void`-fired call — same split `notifySchedulePublished` uses in Slice 3, never inside the write itself.

### 2.3 — This slice adds what Slice 3 could reuse from an existing REST route, but this feature never had: an authentication gate, a length cap, and rate limiting — enforced once, in the shared action, not duplicated per caller.

Three closely-related but distinct gaps, three decisions:

**(a) `requireSession` on both REST routes.** This is an authentication fix, not a product/authorization decision — currently *anyone*, unauthenticated, can hit either endpoint. Adding `requireSession` (a caller must be signed in as *someone*) is squarely "don't ship a known open door," the same class of fix Slice 3's `2026-09-05` precedent already applied to `shifts.ts`/`rotaTemplates.ts`. This spec does **not** additionally restrict the manual UI's Announcement/Shoutout posting to managers-only — the manual feature's existing audience (any signed-in user, per the current UI) is a product-policy question this slice doesn't have the context to decide unilaterally, and changing it isn't necessary to ship voice support. Only the new **voice intents** are manager-gated (`MANAGER_INTENTS`, §7.1) — the REST routes stay open to whatever the current signed-in audience already is, just no longer to anonymous callers.

**(b) A length cap, enforced inside the extracted action.** `announcement.body` / `shoutout.note` get a hard cap — 1000 characters for an announcement, 500 for a shoutout note (chosen to comfortably fit a genuinely spoken paragraph — roughly 150-200 words at natural speaking pace — while rejecting a runaway/garbled transcript rather than silently truncating it, which could cut off content mid-sentence and post something the caller never confirmed). Enforced as a `too_long` result branch inside `createAnnouncement`/`createShoutout` themselves, so REST and voice inherit the identical limit with zero duplicated validation — this is the same reasoning as Slice 3's §2.3, applied here from the start rather than retrofitted.

**(c) Rate limiting, enforced inside the extracted action — not as Express middleware.** Every existing rate limiter in this codebase (`transcribeRateLimiter`, `parseIntentRateLimiter`, `rosterUploadRateLimiter`) is Express middleware wrapping a specific route. That doesn't work here: voice's `/execute` never makes an HTTP round-trip to `POST /api/announcements`/`POST /api/shoutouts` — it calls `createAnnouncement`/`createShoutout` directly, in-process, so a route-level middleware would only ever protect the manual UI's path, silently leaving voice unprotected (and vice versa if attached only to `/execute`). So the check lives inside the action function itself: a simple count of that location's own `Announcement`/`Shoutout` rows created in the last hour (a plain `prisma.count` against `createdAt`, no new infrastructure), rejecting with `rate_limited` past a threshold (proposed: 10 announcements/hour/location, 20 shoutouts/hour/location — shoutouts are naturally more frequent, one per recognized staff member per shift). This protects both callers identically, by construction, the same way the length cap does.

None of (a)-(c) existed to "inherit" — they're new, and are called out explicitly as new rather than silently smuggled in as if they were pre-existing behavior being preserved.

### 2.4 — `POST_SHOUTOUT`'s `shiftSnapshot` is voice-omitted, not voice-required.

The manual UI requires picking both a colleague *and* a specific shift before the note field becomes usable, because `Shoutouts.tsx` is built around browsing a roster grid. Voice has no equivalent browsing step, and forcing the caller to also name a specific shift by voice ("shoutout to Ahmed for his Friday six pm to two am shift...") adds real friction for zero safety benefit — `shiftSnapshot` is a denormalized display string, not a live validated reference (confirmed: the Prisma field is nullable, and the schema comment notes it's deliberately not a live FK since the frontend's parsed roster doesn't reliably carry real `Shift.id`s for every displayed shift). So voice always passes `shiftSnapshot: null`; the manual UI's own requirement is untouched. This is a deliberate UX divergence between the two entry points to the same feature, not an oversight — worth a reviewer's eyes given `Shoutouts.tsx`'s current logic actively disables submission without one.

## 3. Goals

- `POST_ANNOUNCEMENT`: manager says "tell everyone the bar closes early tonight for maintenance" → model produces a cleaned, verbatim-preserved announcement body → confirm-preview shows that exact text → on confirm, posts via the same mutator the manual UI uses, notifying every active staff member at the location.
- `POST_SHOUTOUT`: manager says "give Sarah a shoutout for covering last-minute today" → model resolves the target staff member (same `staffDirectory` resolution `REQUEST_SWAP.targetUserId` already does) and produces a cleaned note → confirm-preview shows the exact note text and who it's for → on confirm, posts via the same mutator, notifying only that staff member.
- Both intents manager-only, structurally absent from the staff Gemini schema.
- `Announcement`/`Shoutout` creation extracted into `lib/actions/communicationActions.ts`; REST routes become thin wrappers; voice's `/execute` calls the identical functions.
- Close the pre-existing authentication gap on both REST routes as part of the same extraction (§2.3a).

## 4. Non-goals (this slice)

- No voice-driven edit/delete of an existing announcement (the manual UI's PATCH/DELETE stay REST-only).
- No change to who the manual UI lets post an announcement/shoutout (§2.3a) — only adds a session requirement, not a role restriction, at the REST layer.
- No profanity/toxicity content moderation model or third-party moderation API — the length cap and rate limit (§2.3) are abuse-surface mitigations, not content moderation; true moderation is a separate, larger feature this slice doesn't attempt.
- No voice-driven browsing/selection of a specific shift for a shoutout (§2.4) — `shiftSnapshot` is always null on the voice path.
- No retry/undo — same as every prior mutating intent, a voice-confirmed post is final (an announcement can still be edited/deleted afterward via the existing manual UI, same as any other announcement).

## 5. Data model changes

None. `Announcement`/`Shoutout` schemas are unchanged — the length cap (§2.3b) is application-layer, not a new `@db.VarChar(n)` column constraint (a DB-level constraint would reject a manual-UI post identically, which is consistent, but changing the column type is a migration or app dogma this slice's scope doesn't need to force — flagged as a candidate follow-up, not blocking). No `VoiceInteractionLog` schema change needed.

## 6. Backend: mutator extraction (`server/src/lib/actions/communicationActions.ts`, new file)

```ts
import { prisma } from '../prisma.js';
import { notifyUsersBatched, notifyUser } from '../push.js';

const ANNOUNCEMENT_BODY_MAX = 1000;
const SHOUTOUT_NOTE_MAX = 500;
const ANNOUNCEMENT_RATE_LIMIT_PER_HOUR = 10;
const SHOUTOUT_RATE_LIMIT_PER_HOUR = 20;

async function recentCount(model: 'announcement' | 'shoutout', locationId: string): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  return prisma[model].count({ where: { locationId, createdAt: { gte: since } } });
}

export type CreateAnnouncementResult =
  | { result: 'ok'; announcement: { id: string; body: string; authorId: string | null; authorName: string | null; createdAt: Date } }
  | { result: 'location_not_found'; message: string }
  | { result: 'author_not_found'; message: string }
  | { result: 'too_long'; message: string }
  | { result: 'rate_limited'; message: string };

export async function createAnnouncement(input: {
  locationId: string;
  authorId: string | null;
  body: string;
}): Promise<CreateAnnouncementResult> {
  if (input.body.length > ANNOUNCEMENT_BODY_MAX) {
    return { result: 'too_long', message: `Announcement text is too long (max ${ANNOUNCEMENT_BODY_MAX} characters).` };
  }
  const location = await prisma.location.findUnique({ where: { id: input.locationId } });
  if (!location) return { result: 'location_not_found', message: `Location "${input.locationId}" not found.` };
  if (input.authorId) {
    const author = await prisma.user.findUnique({ where: { id: input.authorId } });
    if (!author) return { result: 'author_not_found', message: `Author "${input.authorId}" not found.` };
  }
  if ((await recentCount('announcement', input.locationId)) >= ANNOUNCEMENT_RATE_LIMIT_PER_HOUR) {
    return { result: 'rate_limited', message: 'Too many announcements posted recently — please wait before posting another.' };
  }

  const created = await prisma.announcement.create({
    data: { locationId: input.locationId, authorId: input.authorId, body: input.body },
    include: { author: { select: { fullName: true } } },
  });

  const recipients = await prisma.user.findMany({
    where: { locationId: input.locationId, isActive: true, id: { not: input.authorId ?? undefined } },
    select: { id: true },
  });
  void notifyUsersBatched(recipients.map((r) => r.id), { title: 'New announcement', body: input.body, url: '/' });

  return {
    result: 'ok',
    announcement: { id: created.id, body: created.body, authorId: created.authorId, authorName: created.author?.fullName ?? null, createdAt: created.createdAt },
  };
}

export type CreateShoutoutResult =
  | { result: 'ok'; shoutout: { id: string; employeeId: string; employeeName: string; authorId: string | null; authorName: string | null; note: string; createdAt: Date } }
  | { result: 'employee_not_found'; message: string }
  | { result: 'author_not_found'; message: string }
  | { result: 'too_long'; message: string }
  | { result: 'rate_limited'; message: string };

export async function createShoutout(input: {
  locationId: string;
  employeeId: string;
  authorId: string | null;
  shiftSnapshot: string | null;
  note: string;
}): Promise<CreateShoutoutResult> {
  if (input.note.length > SHOUTOUT_NOTE_MAX) {
    return { result: 'too_long', message: `Shoutout note is too long (max ${SHOUTOUT_NOTE_MAX} characters).` };
  }
  const employee = await prisma.user.findUnique({ where: { id: input.employeeId } });
  if (!employee || employee.locationId !== input.locationId) {
    return { result: 'employee_not_found', message: `Staff member "${input.employeeId}" not found.` };
  }
  if (input.authorId) {
    const author = await prisma.user.findUnique({ where: { id: input.authorId } });
    if (!author) return { result: 'author_not_found', message: `Author "${input.authorId}" not found.` };
  }
  if ((await recentCount('shoutout', input.locationId)) >= SHOUTOUT_RATE_LIMIT_PER_HOUR) {
    return { result: 'rate_limited', message: 'Too many shoutouts posted recently — please wait before posting another.' };
  }

  const created = await prisma.shoutout.create({
    data: { locationId: input.locationId, employeeId: input.employeeId, authorId: input.authorId, shiftSnapshot: input.shiftSnapshot, note: input.note },
    include: { employee: { select: { fullName: true } }, author: { select: { fullName: true } } },
  });

  if (created.employeeId !== created.authorId) {
    void notifyUser(created.employeeId, {
      title: 'You got a shoutout!',
      body: `${created.author?.fullName ?? 'Someone'} recognized you: "${created.note}"`,
      url: '/',
    });
  }

  return {
    result: 'ok',
    shoutout: { id: created.id, employeeId: created.employeeId, employeeName: created.employee.fullName, authorId: created.authorId, authorName: created.author?.fullName ?? null, note: created.note, createdAt: created.createdAt },
  };
}
```

`notifyUsersBatched` — confirmed to already exist in `server/src/lib/push.ts` (used by the current inline `announcements.ts`); reused as-is, not reimplemented.

`routes/announcements.ts`'s `POST /` and `routes/shoutouts.ts`'s `POST /` become thin wrappers: add `requireSession` (§2.3a), keep existing request-shape checks (non-empty `body`/`employeeId`/`note`), call the extracted function, map the discriminated result to the existing HTTP status codes (`*_not_found` → 404, `too_long`/`rate_limited` → 400/429, `ok` → 201 with the existing response body shape — no REST API contract change for a successful post).

## 7. Backend: voice intent schema & context

### 7.1 `intentSchema.ts`

```ts
export const MANAGER_INTENTS = [
  ...STAFF_INTENTS,
  /* ...Slice 3's additions..., */
  'POST_ANNOUNCEMENT',
  'POST_SHOUTOUT',
] as const;
```

New `ParsedIntent` variants:

```ts
| { intent: 'POST_ANNOUNCEMENT'; content: string; confidence: number; summary: string }
| { intent: 'POST_SHOUTOUT'; targetUserId: string; targetUserName: string; content: string; confidence: number; summary: string }
```

New shared `properties` field:

```ts
content: {
  type: Type.STRING,
  nullable: true,
  description:
    'For POST_ANNOUNCEMENT — the exact announcement text to post, exactly as it will be shown to staff. For POST_SHOUTOUT — the exact recognition note text. In both cases: lightly clean filler words ("um", "uh"), false starts, and obvious punctuation/capitalization from the transcript, but never paraphrase, shorten, summarize, or add content beyond what was actually said. This is the literal text that will be posted, verbatim, with no further editing.',
},
```

`POST_SHOUTOUT` reuses the existing `targetUserId`/`targetUserName` fields (already shared with `REQUEST_SWAP`, same resolution rule: "one of the ids in the provided staff list, never invent one").

### 7.2 `parseIntent.ts` — `buildContext()`

No new context needed. `ctx.staffDirectory` (built unconditionally, every tier) already gives the model everything it needs to resolve `POST_SHOUTOUT`'s target — the same list `REQUEST_SWAP.targetUserId` already resolves against. `POST_ANNOUNCEMENT` needs no entity resolution at all.

### 7.3 `prompts.ts`

New prompt block (manager-tier, since both intents are manager-only):

```
For POST_ANNOUNCEMENT and POST_SHOUTOUT: put the exact text to post in "content" — clean up filler words and false starts, but never paraphrase, shorten, or add anything beyond what the caller actually said. "content" is what gets posted verbatim; do not describe it in "summary" instead — keep "summary" to a short framing sentence only (e.g. "Post this announcement to the venue", "Give {name} a shoutout with this note"), since the caller will see the full "content" text separately before confirming.
```

This is genuinely new prompt guidance — neither `reason` (REQUEST_SWAP) nor `dutyLabel` (ASSIGN_SECTION), the closest existing free-text fields, get any dedicated prompt handling today (confirmed: both rely solely on their schema `description` string). Given how much more this field matters here, a dedicated instruction block — not just a `description` string — is warranted.

## 8. Backend/Frontend: `/parse-intent` + `/execute` wiring, and the confirm-preview UI change

### 8.1 `/parse-intent`

No server-side post-processing needed for these two intents beyond the existing confidence-threshold gate — unlike `PUBLISH_ROTA`/`APPLY_ROTA_TEMPLATE` (Slice 3), there is no separate server-computed number or independent match-confidence check to layer on. The `content` field is used exactly as the model returns it, subject only to the length cap enforced later in `/execute` (§8.2) — deliberately NOT enforced again at `/parse-intent` time by truncating/rejecting silently, since a rejected-for-length transcript should surface to the caller as an explicit error at confirm or execute time, not a silently shortened preview that doesn't match what they said.

### 8.2 `/execute`

```ts
case 'POST_ANNOUNCEMENT': {
  const result = await createAnnouncement({ locationId, authorId: actorId, body: intent.content });
  if (result.result !== 'ok') {
    const status = result.result === 'rate_limited' ? 429 : result.result === 'too_long' ? 400 : 404;
    return respond(status, { error: result.message }, 'REJECTED_VALIDATION', result.message);
  }
  return respond(201, { executed: true, result: result.announcement }, 'EXECUTED');
}
case 'POST_SHOUTOUT': {
  const target = await prisma.user.findFirst({ where: { id: intent.targetUserId, locationId, isActive: true }, select: { id: true } });
  if (!target) {
    const msg = 'That staff member could not be found at your location.';
    return respond(404, { error: msg }, 'REJECTED_VALIDATION', msg);
  }
  const result = await createShoutout({ locationId, employeeId: intent.targetUserId, authorId: actorId, shiftSnapshot: null, note: intent.content });
  if (result.result !== 'ok') {
    const status = result.result === 'rate_limited' ? 429 : result.result === 'too_long' ? 400 : 404;
    return respond(status, { error: result.message }, 'REJECTED_VALIDATION', result.message);
  }
  return respond(201, { executed: true, result: result.shoutout }, 'EXECUTED');
}
```

The location-scoped target-user existence check mirrors `REQUEST_SWAP`'s identical check — kept in the route/execute layer (not inside `createShoutout`) only for the *location-scoping* half, since `createShoutout` itself already checks the employee exists and belongs to the given `locationId` (§6) — this duplicate-looking check exists because `/execute` is the actual security boundary (per `voice.ts`'s own file-level comment) and must never assume a client-supplied `targetUserId` was already scoped correctly by `/parse-intent`. This is intentionally not "parallel validation logic" in the sense Slice 3's §2.3 ruled out — it's the same *defense-in-depth* pattern `CREATE_SHIFT`'s case already uses for `roleId`/`userId`, not a second copy of the same business-rule check `createAnnouncement`/`createShoutout` also does.

`validateIntentShape` gets two new cases: `POST_ANNOUNCEMENT` requires non-empty `content`; `POST_SHOUTOUT` requires non-empty `content` and non-empty `targetUserId`.

### 8.3 Frontend — the actual UI change (not just wiring)

`VoiceCommandSheet.tsx`'s confirm sheet currently renders one line: `intent.summary`. For `POST_ANNOUNCEMENT`/`POST_SHOUTOUT`, it additionally renders `intent.content` in its own distinct block — visually set apart (quoted/bordered), styled to read clearly as "this is the text that will post," distinct from `summary`'s framing sentence above it. This is the concrete, testable answer to the task's core requirement: the confirm-preview literally cannot show anything other than the exact string that will be written to the database, because there is only one string (`intent.content`) in the entire pipeline from model output to DB write — nothing regenerates or reformats it in between.

## 9. Explicitly deferred (follow-up slices)

- Editing/deleting an announcement by voice.
- A moderation/profanity-filtering pass beyond the length cap + rate limit.
- Letting voice attach a real `shiftId`/`shiftSnapshot` to a shoutout (§2.4).
- Restricting the manual UI's Announcement/Shoutout posting audience by role (a product decision, not this slice's to make).
- A DB-level length constraint on `Announcement.body`/`Shoutout.note` (currently application-layer only, §5).

## 10. Testing plan

**Automated (this slice, before merge):**
- `communicationActions.test.ts`: `createAnnouncement`/`createShoutout` ok paths (real seeded location + staff); `too_long` rejection at exactly-over-the-cap; `rate_limited` rejection after seeding N recent rows; `employee_not_found`/`location_not_found`/`author_not_found` paths.
- `voice.execute.test.ts` additions: `POST_ANNOUNCEMENT`/`POST_SHOUTOUT` end-to-end, asserting the response's posted text is byte-identical to the `content` sent in the request (the core verbatim guarantee); a `STAFF`-session request for either intent asserts 403, same pattern as every prior manager-only intent's role-boundary test.
- A specific regression test asserting `/parse-intent`'s response `content` for these two intents is never mutated/re-derived between response and what a subsequent `/execute` call with that exact object would post — i.e., an explicit test that the pipeline has no second cleanup pass.
- Full existing suite run to confirm no regression in the now-thin-wrapper REST routes, and that the new `requireSession` gate doesn't break any currently-passing (unauthenticated) test — if one exists assuming anonymous access, it will need updating as part of this slice, not treated as an unrelated failure.

**Manual QA (real floor-noise/accent testing, carried over from prior slices):**
- A rambling, filler-heavy spoken announcement ("uh, so like, tell everyone, um, the walk-in's down today, so, yeah, no ice cream orders") — confirm the preview shows a cleaned, but not paraphrased-away, version, and that the exact preview text is what appears on the Home feed after confirming.
- A shoutout naming a real staff member by first name only, where the transcript is otherwise closest to a *different* similarly-named field mention (name resolution ambiguity) — confirm it either resolves correctly or falls back to `UNRECOGNIZED` rather than a wrong target, same standard `REQUEST_SWAP` already meets.
- Attempt to trigger the length cap and the rate limit deliberately (rapid repeated real voice posts) — confirm both produce a clear spoken/visual rejection, not a silent failure.

## 11. Rollout

No feature flag, matching every prior slice. Extraction + REST-route hardening (§2.3a-c) can land as an early, independently-reviewable task within the same PR/plan, same as Slice 3's extraction step — it's a behavior-preserving-for-authenticated-callers refactor plus a closed security gap, not something that needs to ship gated behind the voice intents themselves.
