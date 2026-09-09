# AI Voice: QUERY_MY_SCHEDULE (Slice 2)

Date: 2026-09-10
Status: Approved for implementation planning
Branch: `feat/voice-query-my-schedule`, stacked on `feat/voice-shift-section-tools` (not yet merged to `main` — see §1)

## 1. Context

This is the second slice of the AI voice roadmap that followed the original
CREATE_SHIFT/EDIT_SHIFT/ASSIGN_SECTION spec
(`docs/superpowers/specs/2026-09-09-ai-voice-shift-section-tools-design.md`).
That work (v1) shipped as commits on `feat/voice-shift-section-tools`, pushed
to `origin`, but **not yet merged to `main`** — the PR exists but couldn't be
created by the available `gh` account (collaborator-permissions mismatch on
the repo). This branch stacks directly on `feat/voice-shift-section-tools`
per an explicit decision to not block this slice on that merge.

A broader v2 task ("Full Tool Coverage") was proposed and then substantially
revised after fact-checking against the actual repository:

- `REQUEST_SWAP`/`APPROVE_SWAP`/`DECLINE_SWAP` already shipped **before v1
  even started** — they were never new work. Dropped from any roadmap.
- `TimeOffRequest` has a Prisma model but **no REST mutator/route anywhere**
  in the codebase. Voice tools for it would mean building that mutator from
  scratch first, which is out of sequence with "voice reuses an existing
  mutator." Time-off voice tools are removed from the roadmap entirely until
  that manual-UI-backed mutator exists as its own piece of work.
- `RotaPublish` (mutator inline in `routes/shifts.ts`) and `RotaTemplate`'s
  apply (mutator inline in `routes/rotaTemplates.ts`) both need the same
  `lib/actions/` extraction v1 did for shifts/sections, before voice can
  reuse them. Sequenced as a later slice (Slice 3), not this one.
- `Announcement`/`Shoutout` posting is free-text content with its own
  preview-fidelity requirement. Sequenced last (Slice 4).

This spec covers **only Slice 2: `QUERY_MY_SCHEDULE`** — the smallest and
lowest-risk of the remaining tools, and the first read-only voice intent in
this architecture. Slices 3 and 4 get their own spec/plan cycles later.

## 2. Goal

Add one new intent, `QUERY_MY_SCHEDULE`, letting staff (and managers, since
`STAFF_INTENTS` is a subset of `MANAGER_INTENTS`) ask about their own
upcoming shifts by voice — "What's my next shift", "Am I working this
weekend", "What's my schedule this week" — and get a direct spoken-style
answer with **no confirm step and no `/execute` call**, since nothing is
written.

## 3. Non-goals

- Any other tool from the v2 roadmap (Slices 3/4) — separate specs.
- Time-off voice tools — removed from the roadmap entirely (§1).
- Querying anyone else's schedule, under any phrasing — see §5's structural
  (not prompt-level) guarantee.
- Any change to the confirm-before-execute pipeline for mutating intents —
  unaffected by this slice.

## 4. Why this intent is architecturally different

Every intent shipped so far (`MARK_AVAILABILITY`, `REQUEST_SWAP`,
`APPROVE_SWAP`, `DECLINE_SWAP`, `APPROVE_JOIN`, `DECLINE_JOIN`,
`CREATE_SHIFT`, `EDIT_SHIFT`, `ASSIGN_SECTION`) is a **write**, resolved by
`/parse-intent` and then committed by a separate, explicitly-confirmed call
to `/execute`. `QUERY_MY_SCHEDULE` writes nothing, so it terminates entirely
inside `/parse-intent` — there is no `/execute` call for it at all. Routing
a read through the confirm-before-execute pipeline would be pure noise: it
trains users to tap through confirmations reflexively, which is exactly the
habit that pipeline exists to prevent for the writes that actually matter.

## 5. Design

### 5.1 `intentSchema.ts`

- Add `'QUERY_MY_SCHEDULE'` to `STAFF_INTENTS` (flows into `MANAGER_INTENTS`
  and `ALL_INTENTS` automatically — no separate wiring, same mechanism every
  existing intent already uses).
- New `ParsedIntent` variant: `{ intent: 'QUERY_MY_SCHEDULE'; confidence:
  number; summary: string }` — no other fields. `summary` is repurposed for
  this one intent: instead of "one plain-English sentence describing what
  will happen if confirmed," it is **the direct, final answer** to the
  caller's question (e.g. "You're working Friday 6pm-close and Saturday
  2pm-10pm this weekend", or "You have no shifts scheduled this week").
- `schemaFor()` needs **no new properties** — `intent`, `confidence`, and
  `summary` already exist in the Gemini response schema for every intent.
- Mirror the same variant in `src/api/voice.ts`'s `ParsedIntent` union.

### 5.2 `prompts.ts`

Add one instruction block, gated the same way every other intent-specific
block in this file already is (`if (allowed.includes(...))`):

> For `QUERY_MY_SCHEDULE` specifically: answer using ONLY the caller's own
> upcoming shifts already listed above — you have no visibility into
> anyone else's schedule, so never claim to. Put the direct, final answer
> to their question directly in "summary" (e.g. "You're working Friday
> 6pm-close and Saturday 2pm-10pm this weekend", or "You have no shifts
> scheduled this week") — do NOT describe a pending action, since nothing
> will be written. If the question's date range is genuinely ambiguous
> (e.g. "next week" without clear bounds you can resolve against today's
> date), respond with UNRECOGNIZED instead of guessing.

No change to `PromptContext` or `buildContext()` — the caller's own shifts
are already fetched unconditionally into `ctx.callerShifts` (used today for
`REQUEST_SWAP`) and already shown to the model via the existing "The
caller's own upcoming shifts" block, which fires whenever `allowed.includes
('REQUEST_SWAP')` — true for every role tier today, since `REQUEST_SWAP` is
in `STAFF_INTENTS`. This is the entire safeguard against leaking another
person's schedule: the data for anyone else's shifts is **never in the
model's context at all**, so no phrasing can extract it. This is structural,
not a prompt instruction that could be argued around — the prompt
instruction above is guidance for a good answer, not the security boundary.

### 5.3 `parseIntent.ts`'s `normalizeParsedIntent`

Add one case. Unlike every other case, it needs no field-presence guard —
there are no extra fields to validate:

```ts
case 'QUERY_MY_SCHEDULE':
  return { intent: 'QUERY_MY_SCHEDULE', confidence, summary };
```

The confidence gate in `parseVoiceIntent` (§6.3 of the original spec, lines
162-169 of the current file) applies with **zero special-casing** — a
`QUERY_MY_SCHEDULE` attempt below `CONFIDENCE_THRESHOLD` is coerced to the
same `UNRECOGNIZED`-shaped clarify response every other low-confidence
intent gets, through the exact same code path.

### 5.4 `interactionLog.ts`'s `outcomeAtParseTime` + new enum value

New `VoiceInteractionOutcome` value: `ANSWERED` (additive migration,
alongside the 7 existing values). `outcomeAtParseTime` gains one more
branch, checked in this exact order (checking `resolution.response.intent`,
i.e. the post-confidence-gate value, not `attempted`):

```ts
function outcomeAtParseTime(resolution: VoiceIntentResolution): VoiceInteractionOutcome {
  if (resolution.attempted.intent === 'UNRECOGNIZED') return 'UNRECOGNIZED';
  if (resolution.response.intent === 'UNRECOGNIZED') return 'LOW_CONFIDENCE';
  if (resolution.response.intent === 'QUERY_MY_SCHEDULE') return 'ANSWERED';
  return 'PENDING_CONFIRMATION';
}
```

Ordering matters: a `QUERY_MY_SCHEDULE` attempt that got coerced to
`UNRECOGNIZED` by the confidence gate must log as `LOW_CONFIDENCE` (the
existing branch above it), not `ANSWERED` — nothing was actually answered
in that case, the caller got a clarify response instead. The new branch only
fires for a `QUERY_MY_SCHEDULE` that reached the client as a real answer.

`logParsedInteraction`'s call site (`routes/voice.ts`'s `/parse-intent`
handler) needs **no change** — it already calls `logParsedInteraction`
unconditionally on every successful parse, and that function already calls
`outcomeAtParseTime` internally. The fix above is entirely inside
`interactionLog.ts`.

### 5.5 `/execute` — deliberately no new code

`QUERY_MY_SCHEDULE` is now a member of `STAFF_INTENTS`/`MANAGER_INTENTS`,
so it passes `/execute`'s `ALL_INTENTS.includes(...)` check and
`allowedIntentsFor(...)` permission check like any real intent. It is
**not** added to `validateIntentShape`'s switch (falls to that function's
existing `default: return null;` — shape is trivially valid, nothing to
check) and **not** added to `/execute`'s main switch (falls to that
switch's existing `default: { ... 400 'Unknown intent.' ... }` branch).

This is intentional, correct, fail-closed behavior for the one path that
can still reach `/execute` with this intent: a hand-crafted request that
bypasses the normal client flow (which never calls `/execute` for this
intent at all, since `VoiceCommandSheet` never renders a Confirm button for
it — see §5.6). No new case should be added for it in either switch.

### 5.6 Frontend — `VoiceCommandSheet.tsx` only, `AppShell.tsx` unchanged

`VoiceCommandSheet.tsx` gains one more "no Confirm button" branch, alongside
the existing `isUnrecognized` one:

```ts
const isAnswerOnly = intent.intent === 'QUERY_MY_SCHEDULE';
```

- Confirm button hidden when `isUnrecognized || isAnswerOnly` (today it's
  hidden only for `isUnrecognized`).
- The dismiss button reads "Got it" instead of "Cancel" when `isAnswerOnly`
  — the copy shouldn't imply an action was discarded when nothing was ever
  going to happen. `isUnrecognized`'s dismiss button stays "Cancel" (that
  case genuinely walked away from a potential action, even an unresolved
  one).
- The eyebrow label (`"Didn't catch that"` / `"Confirm voice command"`)
  gets a third value for this case — something like `"Your schedule"`.
- The answer itself needs no new rendering — `intent.summary` is already
  displayed in the sheet body (`<p className="mt-2 text-sm">{intent.summary}
  </p>`), and per §5.1 that's exactly where the direct answer now lives.

`AppShell.tsx` needs **no changes at all**. `handleVoiceCancel` already just
does `setVoiceResult(null)` — fully generic, already correct for dismissing
any non-confirmable intent. Because the Confirm button is hidden for this
intent (the change above), `handleVoiceConfirm` — and therefore
`executeVoiceIntent` — structurally can never be invoked for
`QUERY_MY_SCHEDULE` through the real UI. No defensive guard is needed inside
`handleVoiceConfirm` for this; the same is already true for
`UNRECOGNIZED` today with zero special-casing there.

## 6. Data model change

```prisma
enum VoiceInteractionOutcome {
  PENDING_CONFIRMATION
  LOW_CONFIDENCE
  UNRECOGNIZED
  EXECUTED
  REJECTED_VALIDATION
  REJECTED_PERMISSION
  ERROR
  ANSWERED
}
```

Purely additive (`ALTER TYPE ... ADD VALUE`), no backfill, safe to deploy
ahead of the code that uses it — same rollout shape as v1's
`VoiceInteractionLog` table itself.

## 7. Testing plan

Following `server/src/routes/voice.test.ts`'s existing conventions (real
Express app on an ephemeral port, real Prisma fixtures, cleanup in
`finally`):

- The "never another person's schedule" guarantee is a `buildContext`
  property, not an `/execute` property (this intent never reaches
  `/execute` at all — see §5.5) — test it directly at that level, no Gemini
  call needed: call `buildContext` (or `parseVoiceIntent`, which calls it
  internally) with two STAFF fixtures who each have distinct real shifts,
  and assert the resulting context/prompt built for caller A never contains
  any of caller B's shift data.
- A live-Gemini integration test (guarded by `if (!process.env.GEMINI_API_KEY)
  { return; }`, matching the existing pattern in this file) that sends a
  real transcript ("what's my next shift") for a STAFF fixture with one
  known future shift, and asserts: the returned `intent.intent` is
  `QUERY_MY_SCHEDULE`, `outcome` in the resulting `VoiceInteractionLog` row
  is `ANSWERED` (not `PENDING_CONFIRMATION`), and `intent.summary` is a
  non-empty string.
- The same live test repeated for a MANAGER-tier fixture, to sanity-check
  the `STAFF_INTENTS` → `MANAGER_INTENTS` inheritance actually resolves for
  this specific intent at runtime (not just that it's present in the
  array).
- A unit test on `outcomeAtParseTime` directly (no Gemini call needed) with
  synthetic `VoiceIntentResolution` objects covering all four branches:
  `attempted.intent === 'UNRECOGNIZED'` → `UNRECOGNIZED`; a `QUERY_MY_SCHEDULE`
  `attempted` whose `response` got coerced to `UNRECOGNIZED` by the
  confidence gate → `LOW_CONFIDENCE` (not `ANSWERED` — this is the ordering
  case §5.4 calls out explicitly); a genuine above-threshold
  `QUERY_MY_SCHEDULE` → `ANSWERED`; any other genuine intent → `PENDING_CONFIRMATION`.
  `outcomeAtParseTime` needs to be exported from `interactionLog.ts` for
  this (it is currently private) — a small, low-risk export, not a
  behavior change.
- `/execute`'s fail-closed behavior: a hand-crafted request with
  `intent: { intent: 'QUERY_MY_SCHEDULE', confidence: 0.9, summary: 'x' }`
  gets a real 400 ("Unknown intent."), matching the existing
  `an unknown/garbage intent string gets a real 400` test's shape and
  assertions, run against a real STAFF session (since this intent, unlike a
  truly garbage string, DOES pass the permission check — confirming the
  400 comes from the switch's `default`, not from a 403 or a shape error).

## 8. Rollout

No feature flag, matching how every prior intent shipped. Migration is
additive-only. This slice does not touch `main` directly — it lands on
`feat/voice-query-my-schedule`, stacked on the not-yet-merged
`feat/voice-shift-section-tools`; both PRs (or one combined PR, at the
repo-access-holder's discretion once the `gh` permissions issue is
resolved) merge to `main` whenever that's unblocked.
