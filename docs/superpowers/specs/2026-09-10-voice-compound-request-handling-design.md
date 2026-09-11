# AI Voice: Compound Request Handling (v1 slice)

Date: 2026-09-10
Status: Approved for implementation planning

## 1. Context

ShiftSync's voice pipeline (`server/src/voice/{transcribe,parseIntent,intentSchema,prompts,model}.ts`,
`VoiceCommandSheet.tsx`, `/api/voice/{parse-intent,execute}`) currently
resolves one utterance to one intent, gated by a self-reported `confidence`
score (`CONFIDENCE_THRESHOLD` in `parseIntent.ts`), confirmed via
`VoiceCommandSheet`, and logged to `VoiceInteractionLog`. This spans nine
intents as of `feat/voice-query-my-schedule` (the branch this spec builds
on): `MARK_AVAILABILITY`, `REQUEST_SWAP`, `APPROVE_SWAP`, `DECLINE_SWAP`,
`APPROVE_JOIN`, `DECLINE_JOIN`, `CREATE_SHIFT`, `EDIT_SHIFT`,
`ASSIGN_SECTION`, plus the read-only `QUERY_MY_SCHEDULE`.

A single utterance can name more than one distinct request — "Move Ahmed
to bar and publish the rota", "Approve Sara's swap and tell everyone we're
closing early Friday". Today's pipeline has no defined behavior for this:
Gemini's structured output forces exactly one `intent` value, so a
compound utterance silently collapses to whichever request the model
picks, with no signal to the caller that anything was dropped and no
record that it happened.

## 2. Decision (already made — this spec documents it, not re-derives it)

v1 does **not** execute multiple intents from one utterance, even when
both are clearly identifiable and valid. The pipeline resolves and acts on
only the primary intent (whichever the model naturally surfaces as
`intent`/`summary`/`confidence` today — first-stated or highest-confidence,
indistinguishable from outside the model and not worth forcing a
distinction for), then explicitly prompts the caller to state any
additional request separately, one command at a time. No partial
multi-intent execution, no queuing, no guessing at the second request's
content from the original transcript.

**Rationale:** compound execution multiplies failure surface — two
intents is two chances at misresolution instead of one, and a
partial-completion state (one succeeded, one failed) is hard to
communicate clearly via voice. One thing at a time keeps every
interaction easy to reason about, confirm, and log.

## 3. Goals

- Detect, via a model-self-reported boolean, when a transcript contains
  more than one distinct actionable request.
- Resolve and proceed with only the primary intent through the existing
  pipeline, unchanged — same confidence gate, same confirm-before-execute
  for mutating intents, same direct-answer path for `QUERY_MY_SCHEDULE`.
- Once the primary intent has reached its own terminal state (executed, or
  shown, for a read-only answer), surface a distinct "there's more — go
  again" prompt asking the caller to speak the next request separately.
- Record the detection flag on `VoiceInteractionLog` so compound-request
  frequency is visible in the data, informing whether real multi-intent
  execution is worth building later.

## 4. Non-goals (this slice)

- Any multi-intent parsing, queuing, or sequential auto-execution of a
  second request extracted from the same transcript.
- Re-using or re-parsing any fragment of the original transcript for the
  "additional request" — it must be spoken again as a new, separate
  `/parse-intent` call, because a misheard/ambiguous fragment from a
  compound utterance is not a reliable input to resolve on.
- A numeric confidence score for the detection flag itself — it is a
  boolean, evaluated independently of the primary intent's own
  `confidence` (see §7, edge case 1).
- Any new intents, or any change to `MANAGER_INTENTS`/`STAFF_INTENTS`.

## 5. Data model changes

### 5.1 `VoiceInteractionLog.hasAdditionalRequest` (new column)

```prisma
model VoiceInteractionLog {
  // ...existing fields unchanged...
  hasAdditionalRequest Boolean @default(false) @map("has_additional_request")
}
```

Additive, non-nullable with a default — no backfill needed, safe to
deploy ahead of the code that populates it meaningfully (existing rows
read back as `false`, which is the correct historical answer: the column
didn't exist, so it was never detected).

This records the **raw, model-reported value for the actual attempt**,
regardless of what happened to the primary intent afterward (coerced to
`UNRECOGNIZED` by the confidence gate, genuinely `UNRECOGNIZED`, executed,
or rejected) — the log is the phrasing-frequency dataset described in §3,
and undercounting by only logging the client-surfaced cases would defeat
its purpose.

## 6. Backend: detection

### 6.1 `intentSchema.ts`

Add one field to `schemaFor()`'s properties, alongside `confidence`:

```ts
hasAdditionalRequest: {
  type: Type.BOOLEAN,
  nullable: true,
  description:
    'True if the transcript contains more than one distinct actionable request beyond the one captured in "intent" — e.g. "move Ahmed to bar and publish the rota" has one. Set this independently of how confident you are about "intent" itself: even a low-confidence or UNRECOGNIZED primary intent should still get this flag if a second request is audible.',
},
```

Not added to the schema's `required` array — same convention the shipped
`confidence` field already uses (nullable, defaulted defensively in code
rather than enforced at the schema level). No changes to `ParsedIntent`:
this is not per-intent data, so it does not become a tenth field on every
union variant — it travels alongside the resolved intent as a sibling
value, the same way `voiceLogId` already does today.

### 6.2 `prompts.ts`

Append one instruction to `buildSystemPrompt`'s trailing block (next to
the existing `confidence` instruction):

> Always fill in `hasAdditionalRequest` (true/false): true only if the
> transcript clearly contains a second, distinct actionable request beyond
> the one you resolved as `intent` — not a clarifying detail of the same
> request. Judge this independently of `confidence`: a transcript can be a
> confident single request (`hasAdditionalRequest: false`) or a
> low-confidence/unresolvable one that still audibly contains a second ask
> (`hasAdditionalRequest: true`).

### 6.3 `parseIntent.ts`

- Add an exported `normalizeHasAdditionalRequest(raw): boolean` next to
  `normalizeParsedIntent`, fail-closed to `false` exactly like
  `confidence` fails closed to `0` — an absent or malformed flag must
  never fabricate a compound-request prompt:
  ```ts
  function normalizeHasAdditionalRequest(raw: Record<string, unknown>): boolean {
    return typeof raw.hasAdditionalRequest === 'boolean' ? raw.hasAdditionalRequest : false;
  }
  ```
- Extend `VoiceIntentResolution`:
  ```ts
  export interface VoiceIntentResolution {
    response: ParsedIntent;
    attempted: ParsedIntent;
    /** Raw model-reported flag for the actual attempt — always what the model said, never coerced. Always logged (§5.1); see shouldPromptForAdditionalRequest for the client-facing, suppressed version. */
    hasAdditionalRequest: boolean;
  }
  ```
- In `parseVoiceIntent`, compute `hasAdditionalRequest` once from `raw`
  and include it on **both** return paths (the above-threshold path and
  the confidence-gate-coerced-to-`UNRECOGNIZED` path) — it reflects the
  attempt, not the outcome.
- Add an exported helper, colocated with the other resolution-shaping
  logic:
  ```ts
  /**
   * Whether the CLIENT should be prompted for an additional request.
   * Suppressed whenever the primary intent's client-facing response ends
   * up UNRECOGNIZED — genuinely unresolved, or coerced there by the
   * confidence gate — so a "didn't catch that" turn never also carries a
   * "there's more" prompt (spec §7, edge case 2).
   */
  export function shouldPromptForAdditionalRequest(resolution: VoiceIntentResolution): boolean {
    return resolution.hasAdditionalRequest && resolution.response.intent !== 'UNRECOGNIZED';
  }
  ```

### 6.4 `interactionLog.ts`

- `logParsedInteraction` writes `hasAdditionalRequest: resolution.hasAdditionalRequest`
  (the raw value — see §5.1) to the new column. No change to its
  signature; it already receives the full `resolution`.
- `outcomeAtParseTime` is unchanged — `hasAdditionalRequest` is an
  orthogonal column on the same row, not a new `VoiceInteractionOutcome`
  value. A compound utterance whose primary intent executes is still
  logged as `EXECUTED`/`PENDING_CONFIRMATION` as normal, just with
  `hasAdditionalRequest: true` alongside it.

## 7. Edge cases (already decided — implement as follows)

1. **Primary intent resolves successfully, detection itself is shaky.**
   There is no numeric confidence on `hasAdditionalRequest` to be shaky
   about (§4) — it's a single boolean, evaluated by the model
   independently of `confidence`, and `CONFIDENCE_THRESHOLD` gating in
   §6.3 only ever reads `attempted.confidence`. `hasAdditionalRequest`
   cannot block, delay, or alter the primary intent's own gate/confirm
   flow — it is inert until after that flow's own outcome is known
   (`shouldPromptForAdditionalRequest` reads `resolution.response.intent`,
   which is already fully resolved by the time it's called).
2. **Primary intent fails to resolve (`UNRECOGNIZED`) and
   `hasAdditionalRequest` is true.** Handled by
   `shouldPromptForAdditionalRequest` returning `false` in this case —
   the client-facing response never carries the flag, so
   `VoiceCommandSheet` renders its existing, unchanged "didn't catch
   that" state with no added prompt. This covers both a genuinely
   model-returned `UNRECOGNIZED` and a real intent coerced to
   `UNRECOGNIZED` by the confidence gate — both end with
   `resolution.response.intent === 'UNRECOGNIZED'`. The raw flag is still
   logged (§5.1/§6.4) either way, for the frequency dataset.
3. **Caller repeats the same compound utterance after being prompted.**
   No special handling — `/parse-intent` has no memory of the previous
   call, so this is just a fresh transcript re-entering the flow from
   §6.1 naturally, and may again come back with `hasAdditionalRequest: true`.

## 8. Backend: `/parse-intent` response shape

`routes/voice.ts`'s `/parse-intent` handler:

```ts
const resolution = await parseVoiceIntent(transcript, { ... });
const hasAdditionalRequest = shouldPromptForAdditionalRequest(resolution);
let voiceLogId: string | null = null;
try {
  voiceLogId = await logParsedInteraction({ id: req.user!.id, locationId: req.user!.locationId }, transcript, resolution);
} catch (logErr) { /* unchanged */ }
return res.status(200).json({ transcript, intent: resolution.response, voiceLogId, hasAdditionalRequest });
```

`hasAdditionalRequest` in the response body is the **suppressed, client-facing** value from `shouldPromptForAdditionalRequest` — not the raw `resolution.hasAdditionalRequest` written to the log. No change to `/execute` — this feature has no execute-time behavior; the follow-up prompt is purely a post-primary-intent UI state (§10).

## 9. Frontend: `src/api/voice.ts`

Add `hasAdditionalRequest: boolean` to `parseVoiceIntent`'s return type:

```ts
export async function parseVoiceIntent(
  token: string,
  transcript: string,
): Promise<{ transcript: string; intent: ParsedIntent; voiceLogId: string | null; hasAdditionalRequest: boolean }> {
```

No change to the `ParsedIntent` union (§6.1 — it's not per-intent data) and no change to `executeVoiceIntent`.

## 10. Frontend: `AppShell.tsx` + `VoiceCommandSheet.tsx`

### 10.1 State shape

`voiceResult` gains two fields:

```ts
const [voiceResult, setVoiceResult] = useState<{
  transcript: string;
  intent: ParsedIntent;
  voiceLogId: string | null;
  hasAdditionalRequest: boolean;
  /** Flips true once a mutating intent's /execute has succeeded — keeps the sheet open in its follow-up state instead of clearing immediately. Never set for QUERY_MY_SCHEDULE, which has no execute step. */
  executed?: boolean;
} | null>(null);
```

`handleRecordingComplete` stores the new field from `parseVoiceIntent`'s
response, unchanged otherwise.

### 10.2 `handleVoiceConfirm`

Today, a successful `executeVoiceIntent` always sets a success banner and
clears `voiceResult` unconditionally in `finally`. That has to branch:

```ts
const handleVoiceConfirm = useCallback(async () => {
  if (!voiceResult) return;
  if (!session) {
    setVoiceBanner({ kind: 'error', message: 'Sign in to use voice commands.' });
    setVoiceResult(null);
    return;
  }
  setVoiceExecuting(true);
  try {
    await executeVoiceIntent(session.token, voiceResult.transcript, voiceResult.intent, voiceResult.voiceLogId);
    if (voiceResult.hasAdditionalRequest) {
      // Keep the sheet open, transitioned into its follow-up state — the
      // compound-request prompt is shown IN the sheet (§10.3), not as a
      // separate banner, so there's nothing left for the banner to say.
      setVoiceResult({ ...voiceResult, executed: true });
    } else {
      setVoiceBanner({ kind: 'success', message: voiceResult.intent.summary });
      setVoiceResult(null);
    }
  } catch (err) {
    setVoiceBanner({ kind: 'error', message: err instanceof ApiError ? err.message : 'Could not execute the voice command.' });
    setVoiceResult(null);
  } finally {
    setVoiceExecuting(false);
  }
}, [voiceResult, session]);
```

`handleVoiceCancel` (`setVoiceResult(null)`) is unchanged and is reused as
the follow-up state's single dismiss action.

### 10.3 `VoiceCommandSheet.tsx`

Two new props, `hasAdditionalRequest: boolean` and `executed: boolean`:

```ts
export function VoiceCommandSheet({
  intent,
  transcript,
  hasAdditionalRequest,
  executed,
  onConfirm,
  onCancel,
  executing,
}: {
  intent: ParsedIntent | null;
  transcript: string;
  hasAdditionalRequest: boolean;
  executed: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  executing: boolean;
}) {
  if (!intent) return null;
  const isUnrecognized = intent.intent === 'UNRECOGNIZED';
  const isAnswerOnly = intent.intent === 'QUERY_MY_SCHEDULE';
  // The follow-up prompt only ever appears once the primary intent has
  // reached ITS OWN terminal state: after a successful execute for a
  // mutating intent (`executed`), or immediately for an answer-only intent
  // (which has no execute step to wait for — "shown" and "resolved" are
  // the same moment). An UNRECOGNIZED primary never shows it (edge case 2,
  // spec §7) — the caller already gets `hasAdditionalRequest: false` from
  // the server in that case (§8), so this condition is redundant defense,
  // not the only thing preventing it.
  const showFollowUp = !isUnrecognized && hasAdditionalRequest && (isAnswerOnly || executed);

  const reason = isUnrecognized && intent.reason.trim() ? intent.reason : null;

  const eyebrow = isUnrecognized
    ? "Didn't catch that"
    : showFollowUp
      ? 'Got it — one more thing?'
      : isAnswerOnly
        ? 'Your schedule'
        : 'Confirm voice command';
  const dismissLabel = showFollowUp || isAnswerOnly ? 'Got it' : 'Cancel';
  const showConfirmButton = !isUnrecognized && !isAnswerOnly && !showFollowUp;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-background/70 p-3 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={executing ? undefined : onCancel}
    >
      <div className="panel w-full max-w-sm shadow-lux" onClick={(e) => e.stopPropagation()}>
        <div className="p-5">
          <p className="eyebrow">{eyebrow}</p>
          {transcript.trim() && <p className="mt-2 text-xs text-foreground/60">You said: &ldquo;{transcript.trim()}&rdquo;</p>}
          <p className="mt-2 text-sm">{executed && !isAnswerOnly ? `Done: ${intent.summary}` : intent.summary}</p>
          {reason && <p className="mt-2 text-xs text-foreground/60">{reason}</p>}
          {showFollowUp && (
            <p className="voice-followup mt-3">
              I heard something else in there too — what's the next thing you'd like me to do?
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn btn-ghost" onClick={onCancel} disabled={executing}>
              {dismissLabel}
            </button>
            {showConfirmButton && (
              <button className="btn btn-primary" onClick={onConfirm} disabled={executing}>
                {executing ? 'Executing…' : 'Confirm'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

`AppShell.tsx`'s render call gains the two new props:

```tsx
<VoiceCommandSheet
  intent={voiceResult?.intent ?? null}
  transcript={voiceResult?.transcript ?? ''}
  hasAdditionalRequest={voiceResult?.hasAdditionalRequest ?? false}
  executed={voiceResult?.executed ?? false}
  onConfirm={handleVoiceConfirm}
  onCancel={handleVoiceCancel}
  executing={voiceExecuting}
/>
```

### 10.4 Styling — `.voice-followup`

A new class in `src/styles/global.css`, following the exact recipe the
existing `.error-block-toast` "prominent toast" already uses for a gold,
neither-error-nor-success notice (`global.css:349-356`) — visually
distinct from both the plain confirm-sheet body text and the
`UNRECOGNIZED` state's muted `reason` text:

```css
.voice-followup {
  border: 1px solid var(--accent);
  background: rgba(229, 169, 60, 0.1);
  border-radius: 10px;
  padding: 0.75rem;
  color: var(--accent);
  font-size: var(--text-sm);
}
```

## 11. Testing plan

Real compound phrasings across intent-pair shapes, added to
`server/src/voice/parseIntent.test.ts` and `server/src/routes/voice.test.ts`
following each file's existing structure:

- **`parseIntent.test.ts`** (unit level, mocking/stubbing the Gemini call
  the way existing tests in this file already do):
  - `normalizeHasAdditionalRequest`: `true`/`false`/missing/non-boolean
    input → `true`/`false`/`false`/`false`.
  - `shouldPromptForAdditionalRequest`: above-threshold intent +
    `hasAdditionalRequest: true` → `true`. `UNRECOGNIZED` response +
    `hasAdditionalRequest: true` → `false`. Below-threshold (coerced)
    response + `hasAdditionalRequest: true` → `false`. Any response +
    `hasAdditionalRequest: false` → `false`.
  - `parseVoiceIntent` carries `hasAdditionalRequest` through on both the
    above-threshold and confidence-gate-coerced return paths.

- **`voice.test.ts`** (integration — real Express app, real Prisma
  fixtures, following the file's existing pattern):
  - A mutating+mutating compound ("move Ahmed to bar and publish the
    rota" — stubbed as `ASSIGN_SECTION` with `hasAdditionalRequest: true`,
    since `PUBLISH_ROTA` doesn't exist yet): `/parse-intent` returns
    `hasAdditionalRequest: true`; the returned `intent` is the resolved
    `ASSIGN_SECTION` only — no trace of a second intent anywhere in the
    response; `/execute` against that intent still performs the real
    `SectionAssignment` upsert exactly as it does without the flag.
  - A mutating+read-only compound (schedule query + section assignment,
    per the task's explicit substitution for the unbuilt `TIME_OFF` pair):
    a `QUERY_MY_SCHEDULE` parse with `hasAdditionalRequest: true` →
    response carries the schedule answer in `summary` AND
    `hasAdditionalRequest: true`, unchanged from a non-compound
    `QUERY_MY_SCHEDULE` parse otherwise.
  - `hasAdditionalRequest: true` + a genuinely `UNRECOGNIZED` primary →
    `/parse-intent`'s response has `hasAdditionalRequest: false` (§7 edge
    case 2), even though the row logged has the raw `true`.
  - `hasAdditionalRequest: true` + a below-threshold primary (confidence
    gate coerces to `UNRECOGNIZED`) → same suppression, response has
    `hasAdditionalRequest: false`; the underlying `VoiceInteractionLog`
    row still records `outcome: LOW_CONFIDENCE` (unchanged from today)
    AND `hasAdditionalRequest: true` (the raw attempted value).
  - `VoiceInteractionLog` row assertions: `hasAdditionalRequest` persists
    correctly as `true`/`false` across `EXECUTED`, `PENDING_CONFIRMATION`,
    `ANSWERED`, `LOW_CONFIDENCE`, and `UNRECOGNIZED` outcomes.
  - No test asserts anything about a "second intent" being parsed,
    guessed, or queued — there is no code path that could produce one,
    and the tests should make that absence obvious rather than merely
    coincidental.

**Manual/copy review (not automatable in this environment):** confirm the
follow-up copy ("I heard something else in there too — what's the next
thing you'd like me to do?") reads as an invitation, not an error, when
seen live in the sheet — matches the tone of `VoiceCommandSheet`'s
existing copy rather than introducing a new register.

## 12. Rollout

No feature flag — matches how every prior voice-pipeline slice shipped
directly. The `hasAdditionalRequest` migration is additive-only with a
default, safe to deploy ahead of the code that populates it meaningfully.
