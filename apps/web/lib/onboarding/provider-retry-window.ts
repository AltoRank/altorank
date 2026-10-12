// ---------------------------------------------------------------------------
// How long after a provider outage the overnight retry still picks a run up
// ---------------------------------------------------------------------------
//
// Pure and client-safe: the overnight sweep (./provider-retry.ts) reads the
// window, and the setup screen asks the same question before it promises a
// retry, so the two cannot disagree.

/** A run this recent is left alone: the outage may still be on. */
export const PROVIDER_RETRY_AFTER_MS = 30 * 60_000;
/** A run older than this is not retried by itself: the person has moved on, or been written to. */
export const PROVIDER_RETRY_WITHIN_MS = 3 * 24 * 60 * 60_000;
/** The sweep runs once a night: a run needs a night left in the window to be picked up. */
export const PROVIDER_RETRY_SWEEP_EVERY_MS = 24 * 60 * 60_000;

/**
 * Whether the overnight sweep will still pick up a run that finished at
 * `finishedAt`: a whole night is left before it ages out of
 * PROVIDER_RETRY_WITHIN_MS. A run that
 * finished moments ago is inside it (the sweep waits PROVIDER_RETRY_AFTER_MS
 * first). The setup screen asks this beside the spend gate before it
 * promises a retry, so an owner who comes back on day four is offered the
 * retry button instead of a promise nobody keeps (review, 2026-10-12).
 */
export function providerRetryWindowOpen(finishedAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!finishedAt) return true;
  const at = Date.parse(finishedAt);
  if (!Number.isFinite(at)) return true;
  return at >= now - PROVIDER_RETRY_WITHIN_MS + PROVIDER_RETRY_SWEEP_EVERY_MS;
}
