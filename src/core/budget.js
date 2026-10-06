/**
 * Time limits for MCP calls and for a view's first paint.
 */

/** Per-call timeout hints (ms). `slow` is for tools known to take long (the tracking-script check). */
export const TIMEOUTS = Object.freeze({ default: 15000, slow: 45000 });

/** A call is never started with less than this on the clock. */
export const MIN_CALL_MS = 1000;

/** A per-call timeout clamped to what is left before `deadline` (never below MIN_CALL_MS). */
export function clampTimeout(timeoutMs, deadline, fallback = TIMEOUTS.default) {
  const want = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : fallback;
  if (!deadline) return want;
  return Math.min(want, Math.max(MIN_CALL_MS, deadline - Date.now()));
}

/** How long a view's `render` may run before the shell gives up on it and shows an error with Retry. */
export const VIEW_LOAD_MS = 120000;
