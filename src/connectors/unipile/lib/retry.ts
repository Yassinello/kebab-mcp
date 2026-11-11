/**
 * Phase 68 / Plan 02 / Task 2 — Exponential-backoff retry helper.
 *
 * The Unipile Node SDK does NOT ship native retry middleware
 * [VERIFIED: src/request-sender.ts in unipile-node-sdk@1.9.3]. This helper
 * wraps any SDK call (or Promise-returning fn) and retries on the precise
 * set of transient HTTP statuses that LinkedIn / Unipile docs document as
 * recoverable: 429 (rate limit) and 502/503/504 (gateway upstream blips).
 *
 * Non-retryable statuses (400/403/404/422) and non-SDK errors throw
 * immediately on attempt 1 — those are caller mistakes or persistent
 * upstream conditions where retry would only amplify load.
 *
 * Backoff formula: baseMs * 2^(attempt-1) * (0.8 + random()*0.4)
 *   → defaults: ~200ms, ~400ms, ~800ms (±20% jitter)
 *   → worst-case wall-clock with max=3: ~1.4s before final throw, well
 *     inside Vercel's 60s lambda budget (T-68-02-04 mitigation).
 *
 * Tests use vi.useFakeTimers() + vi.runAllTimersAsync() to avoid sleeping
 * in CI — see lib/__tests__/retry.test.ts.
 */

import { UnsuccessfulRequestError } from "unipile-node-sdk";

const RETRYABLE = new Set([429, 502, 503, 504]);
const DEFAULT_MAX = 3;
const BASE_MS = 200;

/**
 * Statuses safe to retry for a NON-idempotent write (a message send): only 429,
 * where the request was rejected before processing. A 502/503/504 may arrive
 * after the provider already delivered the message — retrying would double-send.
 */
export const WRITE_RETRYABLE: ReadonlySet<number> = new Set([429]);

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { max?: number; baseMs?: number; statuses?: ReadonlySet<number> } = {}
): Promise<T> {
  const max = opts.max ?? DEFAULT_MAX;
  const baseMs = opts.baseMs ?? BASE_MS;
  const retryable = opts.statuses ?? RETRYABLE;
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (
        attempt >= max ||
        !(err instanceof UnsuccessfulRequestError) ||
        !retryable.has((err.body as { status?: number } | null)?.status ?? 0)
      ) {
        throw err;
      }
      // Exponential backoff with jitter: ~200ms, ~400ms, ~800ms (±20%)
      const delay = baseMs * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
