import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { AiBudgetExceededError, type AiCallUsage, type AiFeature } from './aiBudget.js';

/**
 * Opt-in spend meter for owner-authorized live test runs on a developer machine. It is OFF
 * unless `AI_SPEND_METER_LOG` names a file (production never sets it).
 *
 * When on, every model call that goes through `withAiBudget` is checked BEFORE it is sent:
 * if the running total in the log plus the call's worst case would pass
 * `AI_SPEND_METER_STOP_USD`, nothing is sent and the call is refused like a budget stop. After
 * the call, one JSON line is appended with its estimated cost and the new running total. The
 * total lives in the file, so it holds across processes, restarts and retries (each retry is
 * its own call). Amounts and token counts only — no content, names or ids.
 */
export interface SpendMeter {
  log: string;
  stopUsd: number;
}

export function spendMeter(env: NodeJS.ProcessEnv = process.env): SpendMeter | null {
  const log = (env.AI_SPEND_METER_LOG ?? '').trim();
  if (!log) return null;
  const stopUsd = Number((env.AI_SPEND_METER_STOP_USD ?? '').trim());
  if (!Number.isFinite(stopUsd) || stopUsd <= 0) {
    // Fail closed: a meter without a stop value must never let calls through.
    throw new AiBudgetExceededError('monthly_budget');
  }
  return { log, stopUsd };
}

/** Sum of every recorded call's `usd` in the log (0 when the file doesn't exist yet). */
export function meteredTotalUsd(log: string): number {
  if (!existsSync(log)) return 0;
  let total = 0;
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const usd = Number((JSON.parse(line) as { usd?: unknown }).usd);
      if (Number.isFinite(usd)) total += usd;
    } catch {
      // Not a JSON line (e.g. a note added by hand): ignore it.
    }
  }
  return total;
}

const round = (usd: number) => Number(usd.toFixed(6));

/** Refuses (throws) when the running total plus this call's worst case would pass the stop value. */
export function meterCheck(meter: SpendMeter, feature: AiFeature, worstCaseUsd: number, now: Date = new Date()): void {
  const total = meteredTotalUsd(meter.log);
  if (total + worstCaseUsd <= meter.stopUsd) return;
  appendFileSync(
    meter.log,
    `${JSON.stringify({ at: now.toISOString(), event: 'stopped', feature, worstCaseUsd: round(worstCaseUsd), cumulativeUsd: round(total), stopUsd: meter.stopUsd })}\n`,
  );
  throw new AiBudgetExceededError('monthly_budget');
}

export function meterRecord(
  meter: SpendMeter,
  entry: { feature: AiFeature; usd: number; worstCaseUsd: number; usage: AiCallUsage; ok: boolean },
  now: Date = new Date(),
): void {
  const cumulativeUsd = round(meteredTotalUsd(meter.log) + entry.usd);
  appendFileSync(
    meter.log,
    `${JSON.stringify({
      at: now.toISOString(),
      event: 'call',
      feature: entry.feature,
      ok: entry.ok,
      usd: round(entry.usd),
      worstCaseUsd: round(entry.worstCaseUsd),
      inputTokens: entry.usage.inputTokens,
      outputTokens: entry.usage.outputTokens,
      cumulativeUsd,
    })}\n`,
  );
}
