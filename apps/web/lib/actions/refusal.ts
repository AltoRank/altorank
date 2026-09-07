// ---------------------------------------------------------------------------
// A refusal the person who clicked can read
// ---------------------------------------------------------------------------
//
// Next.js replaces a thrown server-action message with an opaque hex digest in
// a production build, so every `toast.error(err.message)` in this app showed
// the customer a digest rather than the sentence the action wrote. The billing
// actions learned this first (`lib/billing/failure.ts`); this is the same idea
// for the rest, kept deliberately small so an action can adopt it without
// changing what it already returns on success.
//
// Two kinds of failure, treated differently on purpose:
//
//   - A REFUSAL is expected and explainable: no plan, wrong status, a figure
//     with no source, a domain we cannot reach. It travels as data.
//   - A FAULT is anything else. It still throws, because the honest message
//     for "we do not know what happened" is a generic one, and the digest is
//     no worse than the real text would have been.

/** Success shape `T` plus the one field a caller checks before believing it. */
export type Refusable<T = object> = T & { refused?: string };

/** Build a refusal. Logged, so the server side is still findable. */
export function refuse<T = object>(message: string, context?: string): Refusable<T> {
  if (context) console.warn(`[refused] ${context}: ${message}`);
  return { refused: message } as Refusable<T>;
}

/**
 * `true` when the action declined. Narrow with this rather than reading the
 * field, so a caller cannot forget that a resolved promise may still be a no.
 */
export function wasRefused<T>(result: Refusable<T> | null | undefined): result is Refusable<T> & { refused: string } {
  return typeof (result as { refused?: unknown } | null | undefined)?.refused === "string";
}
