// ---------------------------------------------------------------------------
// When a customer last signed in, not counting "View as"
// ---------------------------------------------------------------------------
//
// "View as" (app/actions/impersonation.ts) verifies a sign-in link for the
// customer, and the auth server stamps their `last_sign_in_at` for it. The
// Users page read that as the customer's Last seen and counted them in "Seen
// this week" after an operator looked at their account.
//
// Every view is logged before the link is minted, and since migration 116
// the log row keeps the customer's own last sign-in from just before. A sign-in
// that lands just after a view started is the view's; the customer's own is
// the one the row kept, and that one may itself be an earlier view's, so the
// walk repeats.

/** A sign-in this long after a view was logged is the view's own. */
export const VIEW_SIGN_IN_WINDOW_MS = 2 * 60 * 1000;

export interface ViewRecord {
  startedAt: string;
  /**
   * The customer's last sign-in from before the view: null when they had
   * none, undefined when the row does not say (written before migration 116).
   */
  priorSignInAt?: string | null;
}

export interface CustomerLastSeen {
  /** The customer's own last sign-in, or null when there is none or it is not known. */
  at: string | null;
  /** The stamped sign-in was a view's, and what came before it is not on record. */
  unknown: boolean;
}

export function customerLastSeen(lastSignInAt: string | null | undefined, views: readonly ViewRecord[]): CustomerLastSeen {
  let at = lastSignInAt ?? null;
  // Each step moves to an earlier record; more steps than records is a loop.
  for (let step = 0; at && step <= views.length; step++) {
    const t = Date.parse(at);
    const view = views.find((v) => {
      const s = Date.parse(v.startedAt);
      return t >= s && t - s <= VIEW_SIGN_IN_WINDOW_MS;
    });
    if (!view) return { at, unknown: false };
    if (view.priorSignInAt === undefined) return { at: null, unknown: true };
    at = view.priorSignInAt;
  }
  return { at, unknown: false };
}
