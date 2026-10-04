import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import type { RequestHandler } from 'express';

/**
 * Per-request id, carried through async work with AsyncLocalStorage, so every log line written
 * while handling a request can be tied back to it (and to the `X-Request-Id` response header a
 * user or an uptime check can quote).
 */
const store = new AsyncLocalStorage<{ requestId: string }>();

/** An id we accept from the caller (a proxy or the client): short and plain, never free text. */
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function currentRequestId(): string | undefined {
  return store.getStore()?.requestId;
}

export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  const requestId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', requestId);
  store.run({ requestId }, () => next());
};

/**
 * Masks phone-number shapes — an international number (`+` then 8–15 digits, spaces or dashes
 * allowed) or 9–15 digits in a row — keeping the last two digits: enough to tell two numbers
 * apart in a log, not enough to call one. Dates (`2026-10-04`) and times are left alone.
 * Error text from the database layer can echo query values; this keeps phones out of logs.
 */
export function maskPhones(text: string): string {
  return text.replace(/\+\d(?:[ -]?\d){7,14}|\b\d{9,15}\b/g, (m) => {
    const digits = m.replace(/\D/g, '');
    return `${m.startsWith('+') ? '+' : ''}${'•'.repeat(Math.max(0, digits.length - 2))}${digits.slice(-2)}`;
  });
}

function render(arg: unknown): unknown {
  if (typeof arg === 'string') return maskPhones(arg);
  if (arg instanceof Error || (typeof arg === 'object' && arg !== null)) return maskPhones(inspect(arg, { depth: 4 }));
  return arg;
}

type ConsoleLike = Pick<Console, 'log' | 'info' | 'warn' | 'error'>;
const INSTALLED = Symbol.for('shiftsync.logContext');

/**
 * Wraps the console once (idempotent): every line gets `[rid=<first 8 of the id>]` when written
 * inside a request, and phone-number shapes are masked in all arguments. Called by the server
 * entry point only, so unit tests see the plain console.
 */
export function installLogContext(target: ConsoleLike = console): void {
  const marked = target as ConsoleLike & { [INSTALLED]?: boolean };
  if (marked[INSTALLED]) return;
  marked[INSTALLED] = true;
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      const rid = currentRequestId();
      const rendered = args.map(render);
      original(...(rid ? [`[rid=${rid.slice(0, 8)}]`, ...rendered] : rendered));
    };
  }
}
