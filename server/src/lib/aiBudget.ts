import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { meterCheck, meterRecord, spendMeter } from './aiSpendMeter.js';

/**
 * The hard in-app cap on Gemini / Vertex spend. EVERY model call (roster
 * vision, voice transcription, voice intent) goes through `withAiBudget`:
 *
 *  1. Before the call, its worst-case cost (estimated input tokens + the
 *     feature's output-token ceiling, at the configured prices) is RESERVED
 *     against this UTC month's deployment-wide counter, and today's call count
 *     is incremented — both as single conditional updates in one transaction,
 *     so parallel calls can never push the total past the limits. If either
 *     limit would be crossed, nothing is sent to the provider.
 *  2. After the call, the reservation is settled to the real cost from the
 *     response's token counts (output includes "thinking" tokens). With no
 *     token counts, or a network failure / timeout (the request may still have
 *     been billed), the whole reservation is charged. An error status from the
 *     provider is charged nothing (it isn't billed) but still counts as a call.
 *
 * Google-side budget alerts only notify; this is the stop. Amounts and counts
 * only — no content, names, phone numbers or audio is ever recorded.
 */

export type AiFeature = 'roster_vision' | 'voice_transcribe' | 'voice_intent' | 'self_test_vision' | 'self_test_voice';

/** Output ceiling per call, thinking included (Gemini counts thought tokens against maxOutputTokens). */
export const MAX_OUTPUT_TOKENS: Record<AiFeature, number> = {
  roster_vision: 16_384,
  voice_transcribe: 1_024,
  voice_intent: 2_048,
  self_test_vision: 256,
  self_test_voice: 256,
};

export type AiFeatureGroup = 'vision' | 'voice';

export function featureGroup(feature: AiFeature): AiFeatureGroup {
  return feature === 'roster_vision' || feature === 'self_test_vision' ? 'vision' : 'voice';
}

/** AI roster reads (photo/scan uploads) per venue per rolling 7 days. */
export const DEFAULT_VISION_WEEKLY_LIMIT = 1;

/** `AI_VISION_WEEKLY_LIMIT`: a whole number ≥ 0 (0 switches AI roster reading off); anything else uses the default. */
export function visionWeeklyLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.AI_VISION_WEEKLY_LIMIT ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 0 ? n : DEFAULT_VISION_WEEKLY_LIMIT;
}

export const DEFAULT_MONTHLY_BUDGET_USD = 5;
export const DEFAULT_VISION_DAILY_CALL_LIMIT = 60;
/** Model calls, not commands: one voice command is two calls (transcribe + understand). */
export const DEFAULT_VOICE_DAILY_CALL_LIMIT = 200;
/** All AI calls per UTC day when AI_DAILY_CALL_LIMIT is unset: unset is never unlimited. */
export const DEFAULT_DAILY_CALL_LIMIT = 150;
/** Per person and per venue, per UTC day, in model calls (a voice command is two). */
export const DEFAULT_VOICE_USER_DAILY_LIMIT = 40;
export const DEFAULT_VOICE_VENUE_DAILY_LIMIT = 100;
export const DEFAULT_VISION_USER_DAILY_LIMIT = 10;
export const DEFAULT_VISION_VENUE_DAILY_LIMIT = 20;
/**
 * Deliberately at or above the highest per-token price Google lists for the
 * configured models (checked 2026-10-04: Gemini 3.6 Flash, Priority tier,
 * non-global endpoint, from 2027-01-01 — $2.97 in / $14.85 out per 1M tokens).
 */
export const DEFAULT_PRICE_IN_PER_M = 3;
export const DEFAULT_PRICE_OUT_PER_M = 15;

export const AI_PAUSED_MESSAGE = 'AI reading is paused for this month; upload Excel/CSV or add staff manually.';
export const AI_PAUSED_TODAY_MESSAGE = "AI reading has reached today's limit and is back tomorrow; upload Excel/CSV or add staff manually.";
export const AI_PAUSED_USER_MESSAGE = "You've used today's AI roster reading; it's back tomorrow. Upload Excel/CSV or add staff manually.";
export const AI_PAUSED_VENUE_MESSAGE = "Your venue has used today's AI roster reading; it's back tomorrow. Upload Excel/CSV or add staff manually.";

export interface AiBudgetConfig {
  monthlyBudgetUsd: number;
  /** AI_DAILY_CALL_LIMIT: ceiling on all features together (default 150). 0 stops every call. */
  dailyCallLimit: number;
  visionDailyCallLimit: number;
  voiceDailyCallLimit: number;
  /** Per person / per venue per day, by feature group. */
  quotas: Record<AiFeatureGroup, { user: number; venue: number }>;
  priceInPerM: number;
  priceOutPerM: number;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? '').trim());
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function aiBudgetConfig(env: NodeJS.ProcessEnv = process.env): AiBudgetConfig {
  const whole = (raw: string | undefined, fallback: number) => Math.floor(positiveNumber(raw, fallback));
  return {
    monthlyBudgetUsd: positiveNumber(env.AI_MONTHLY_BUDGET_USD, DEFAULT_MONTHLY_BUDGET_USD),
    dailyCallLimit: whole(env.AI_DAILY_CALL_LIMIT, DEFAULT_DAILY_CALL_LIMIT),
    visionDailyCallLimit: whole(env.AI_VISION_DAILY_CALL_LIMIT, DEFAULT_VISION_DAILY_CALL_LIMIT),
    voiceDailyCallLimit: whole(env.AI_VOICE_DAILY_CALL_LIMIT, DEFAULT_VOICE_DAILY_CALL_LIMIT),
    quotas: {
      voice: { user: whole(env.AI_VOICE_USER_DAILY_LIMIT, DEFAULT_VOICE_USER_DAILY_LIMIT), venue: whole(env.AI_VOICE_VENUE_DAILY_LIMIT, DEFAULT_VOICE_VENUE_DAILY_LIMIT) },
      vision: { user: whole(env.AI_VISION_USER_DAILY_LIMIT, DEFAULT_VISION_USER_DAILY_LIMIT), venue: whole(env.AI_VISION_VENUE_DAILY_LIMIT, DEFAULT_VISION_VENUE_DAILY_LIMIT) },
    },
    priceInPerM: positiveNumber(env.AI_PRICE_IN_PER_M, DEFAULT_PRICE_IN_PER_M),
    priceOutPerM: positiveNumber(env.AI_PRICE_OUT_PER_M, DEFAULT_PRICE_OUT_PER_M),
  };
}

export function costUsd(inputTokens: number, outputTokens: number, config: AiBudgetConfig): number {
  return (inputTokens * config.priceInPerM + outputTokens * config.priceOutPerM) / 1_000_000;
}

/** UTC calendar keys for the month and day counters. */
export function budgetKeys(now: Date): { month: string; day: string } {
  const iso = now.toISOString();
  return { month: iso.slice(0, 7), day: iso.slice(0, 10) };
}

export type AiLimit = 'monthly_budget' | 'daily_calls' | 'user_daily' | 'venue_daily' | 'ledger_unavailable';

const LIMIT_MESSAGE: Record<AiLimit, string> = {
  monthly_budget: 'Monthly AI budget reached.',
  daily_calls: 'Daily AI call limit reached.',
  user_daily: "This person's daily AI limit reached.",
  venue_daily: "This venue's daily AI limit reached.",
  ledger_unavailable: 'AI spend ledger unreachable.',
};

export class AiBudgetExceededError extends Error {
  /** `ledger_unavailable`: the spend counters couldn't be reached, so the call is refused (fail closed). */
  constructor(readonly limit: AiLimit) {
    super(LIMIT_MESSAGE[limit]);
    this.name = 'AiBudgetExceededError';
  }
}

export interface AiCallUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AiCallRequest {
  /** The venue the call is for (ledger row, venue quota); null for operator diagnostics, which still count. */
  locationId: string | null;
  /** The signed-in person the call is for (their daily quota); null for operator diagnostics. */
  userId?: string | null;
  feature: AiFeature;
  /** Worst-case input tokens for this call (prompt + media). */
  inputTokensEstimate: number;
}

interface Deps {
  db?: typeof prisma;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

/** A provider answered with an HTTP error status: not billed. Anything else (timeout, network) may have been. */
function providerAnsweredWithError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400;
}

export async function withAiBudget<T>(
  request: AiCallRequest,
  call: () => Promise<{ value: T; usage: AiCallUsage }>,
  deps: Deps = {},
): Promise<T> {
  const db = deps.db ?? prisma;
  const config = aiBudgetConfig(deps.env);
  const { month, day } = budgetKeys((deps.now ?? (() => new Date()))());
  const reserved = Number(costUsd(Math.max(0, request.inputTokensEstimate), MAX_OUTPUT_TOKENS[request.feature], config).toFixed(6));
  // Local live test runs only (off unless AI_SPEND_METER_LOG is set): stop before the call.
  const meter = spendMeter(deps.env);
  if (meter) meterCheck(meter, request.feature, reserved);

  try {
    await reserve(db, config, month, day, reserved, featureGroup(request.feature), request);
  } catch (err) {
    if (err instanceof AiBudgetExceededError) throw err;
    console.error('[ai-budget] spend ledger unreachable — refusing the AI call:', err instanceof Error ? err.message : err);
    throw new AiBudgetExceededError('ledger_unavailable');
  }

  let usage: AiCallUsage = { inputTokens: null, outputTokens: null };
  let charged = reserved;
  let ok = false;
  try {
    const result = await call();
    usage = result.usage;
    if (usage.inputTokens !== null && usage.outputTokens !== null) {
      charged = Number(costUsd(usage.inputTokens, usage.outputTokens, config).toFixed(6));
    }
    ok = true;
    return result.value;
  } catch (err) {
    if (providerAnsweredWithError(err)) charged = 0;
    throw err;
  } finally {
    if (meter) meterRecord(meter, { feature: request.feature, usd: charged, worstCaseUsd: reserved, usage, ok });
    await settle(db, config, { month, request, reserved, charged, usage }).catch((err) => {
      // The call itself already happened; a ledger hiccup must not turn it into a user error.
      console.error(`[ai-budget] could not settle a ${request.feature} call:`, err instanceof Error ? err.message : err);
    });
  }
}

async function reserve(
  db: typeof prisma,
  config: AiBudgetConfig,
  month: string,
  day: string,
  reserved: number,
  group: AiFeatureGroup,
  request: AiCallRequest,
): Promise<void> {
  const overall = config.dailyCallLimit;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO ai_spend_months (month) VALUES (${month}) ON CONFLICT (month) DO NOTHING`;
    await tx.$executeRaw`INSERT INTO ai_call_days (day) VALUES (${day}) ON CONFLICT (day) DO NOTHING`;
    const reservedRows = await tx.$executeRaw`
      UPDATE ai_spend_months SET reserved_usd = reserved_usd + ${reserved}::numeric, updated_at = now()
      WHERE month = ${month} AND spent_usd + reserved_usd + ${reserved}::numeric <= ${config.monthlyBudgetUsd}::numeric`;
    if (reservedRows === 0) throw new AiBudgetExceededError('monthly_budget');
    const counted =
      group === 'vision'
        ? await tx.$executeRaw`UPDATE ai_call_days SET calls = calls + 1, vision_calls = vision_calls + 1
            WHERE day = ${day} AND calls < ${overall} AND vision_calls < ${config.visionDailyCallLimit}`
        : await tx.$executeRaw`UPDATE ai_call_days SET calls = calls + 1, voice_calls = voice_calls + 1
            WHERE day = ${day} AND calls < ${overall} AND voice_calls < ${config.voiceDailyCallLimit}`;
    if (counted === 0) throw new AiBudgetExceededError('daily_calls');
    // Beneath the deployment-wide limits: one venue, and one person, can't spend everyone's allowance.
    const scopes: [scope: 'venue' | 'user', id: string | null | undefined, limit: number, refusal: AiLimit][] = [
      ['venue', request.locationId, config.quotas[group].venue, 'venue_daily'],
      ['user', request.userId, config.quotas[group].user, 'user_daily'],
    ];
    for (const [scope, id, limit, refusal] of scopes) {
      if (!id) continue;
      await tx.$executeRaw`INSERT INTO ai_call_quotas (day, scope, scope_id, feature_group) VALUES (${day}, ${scope}, ${id}, ${group}) ON CONFLICT DO NOTHING`;
      const ok = await tx.$executeRaw`UPDATE ai_call_quotas SET calls = calls + 1
        WHERE day = ${day} AND scope = ${scope} AND scope_id = ${id} AND feature_group = ${group} AND calls < ${limit}`;
      if (ok === 0) throw new AiBudgetExceededError(refusal);
    }
  });
}

async function settle(
  db: typeof prisma,
  config: AiBudgetConfig,
  s: { month: string; request: AiCallRequest; reserved: number; charged: number; usage: AiCallUsage },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE ai_spend_months
      SET reserved_usd = GREATEST(reserved_usd - ${s.reserved}::numeric, 0), spent_usd = spent_usd + ${s.charged}::numeric, updated_at = now()
      WHERE month = ${s.month}`;
    if (s.request.locationId) {
      const input = s.usage.inputTokens ?? 0;
      const output = s.usage.outputTokens ?? 0;
      await tx.aiUsage.upsert({
        where: { locationId_feature_month: { locationId: s.request.locationId, feature: s.request.feature, month: s.month } },
        create: { locationId: s.request.locationId, feature: s.request.feature, month: s.month, calls: 1, inputTokens: input, outputTokens: output, estimatedUsd: new Prisma.Decimal(s.charged) },
        update: { calls: { increment: 1 }, inputTokens: { increment: input }, outputTokens: { increment: output }, estimatedUsd: { increment: new Prisma.Decimal(s.charged) } },
      });
    }
  });
  // Loud, once per month, the first time estimated spend reaches 80% of the cap.
  const crossed = await db.$executeRaw`
    UPDATE ai_spend_months SET warned_80 = true
    WHERE month = ${s.month} AND warned_80 = false AND spent_usd >= ${config.monthlyBudgetUsd * 0.8}::numeric`;
  if (crossed > 0) {
    console.warn(
      `[ai-budget] WARNING: estimated AI spend for ${s.month} has reached 80% of AI_MONTHLY_BUDGET_USD ($${config.monthlyBudgetUsd}). ` +
        'AI reading and voice stop for the rest of the month at 100%.',
    );
  }
}

export interface AiUsageSummary {
  month: string;
  monthToDateUsd: number;
  limitUsd: number;
  /** All features together, and the overall ceiling (AI_DAILY_CALL_LIMIT, default 150). */
  callsToday: number;
  callLimit: number;
  /** Every AI feature is refused: monthly budget or the overall daily ceiling reached. */
  paused: boolean;
  vision: { callsToday: number; callLimit: number; paused: boolean };
  voice: { callsToday: number; callLimit: number; paused: boolean };
  venue: { monthToDateUsd: number; calls: number };
}

/** What GET /api/ai/usage shows the owner: the shared cap's state plus this venue's own share. */
export async function aiUsageSummary(locationId: string, deps: Deps = {}): Promise<AiUsageSummary> {
  const db = deps.db ?? prisma;
  const config = aiBudgetConfig(deps.env);
  const { month, day } = budgetKeys((deps.now ?? (() => new Date()))());
  const [spend, calls, venueRows] = await Promise.all([
    db.aiSpendMonth.findUnique({ where: { month } }),
    db.aiCallDay.findUnique({ where: { day } }),
    db.aiUsage.findMany({ where: { locationId, month } }),
  ]);
  const monthToDateUsd = Number(spend?.spentUsd ?? 0) + Number(spend?.reservedUsd ?? 0);
  const callsToday = calls?.calls ?? 0;
  const paused = monthToDateUsd >= config.monthlyBudgetUsd || callsToday >= config.dailyCallLimit;
  const feature = (used: number, limit: number) => ({ callsToday: used, callLimit: limit, paused: paused || used >= limit });
  return {
    month,
    monthToDateUsd: Number(monthToDateUsd.toFixed(4)),
    limitUsd: config.monthlyBudgetUsd,
    callsToday,
    callLimit: config.dailyCallLimit,
    paused,
    vision: feature(calls?.visionCalls ?? 0, config.visionDailyCallLimit),
    voice: feature(calls?.voiceCalls ?? 0, config.voiceDailyCallLimit),
    venue: {
      monthToDateUsd: Number(venueRows.reduce((n, r) => n + Number(r.estimatedUsd), 0).toFixed(4)),
      calls: venueRows.reduce((n, r) => n + r.calls, 0),
    },
  };
}

/** Rough worst-case input tokens for a roster file (Gemini bills ~258–1,120 tokens per image or PDF page). */
export function visionInputEstimate(input: { kind: 'file'; data: Buffer; mimeType: string } | { kind: 'grid'; text: string }): number {
  const prompt = 4_000;
  if (input.kind === 'grid') return prompt + Math.ceil(input.text.length / 2);
  if (input.mimeType === 'application/pdf') return prompt + Math.ceil(input.data.length / 50_000) * 1_500 + 1_500;
  return prompt + 6_000;
}

/** Worst-case input tokens for an audio clip: 32 tokens per second, assuming the lowest plausible bitrate (1 kB/s). */
export function audioInputEstimate(bytes: number): number {
  return 1_000 + Math.ceil(bytes / 1_024) * 32;
}

/** Worst-case input tokens for a text prompt (about 4 characters per token, rounded up generously). */
export function textInputEstimate(...parts: string[]): number {
  return 500 + Math.ceil(parts.reduce((n, p) => n + p.length, 0) / 3);
}
