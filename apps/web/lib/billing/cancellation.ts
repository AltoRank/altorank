// ---------------------------------------------------------------------------
// Cancelling: the survey, and what the confirmation has to say
// ---------------------------------------------------------------------------
//
// Two screens, in this order: why, then what happens. The survey is required
// because the answer is the one thing a cancellation teaches us; the
// confirmation names the consequence in plain terms rather than warning. No
// downsell, no countdown, no "are you sure" with a sad face.

export const CANCEL_REASONS = [
  { id: "quality", label: "Article quality doesn't meet my standards" },
  { id: "no_results", label: "Not seeing results" },
  { id: "price", label: "Too expensive for what I get" },
  { id: "switched", label: "Switched to another tool" },
  { id: "no_need", label: "Don't need it anymore" },
  { id: "other", label: "Other" },
] as const;

export type CancelReason = (typeof CANCEL_REASONS)[number]["id"];

export interface CancellationAnswers {
  reason: string | null | undefined;
  detail?: string | null;
}

export type CancellationValidation =
  | { ok: true; reason: CancelReason; detail: string | null }
  | { ok: false; error: string };

/** A reason is required; "Other" needs a few words so the row means something. */
export function validateCancellation(a: CancellationAnswers): CancellationValidation {
  const reason = CANCEL_REASONS.find((r) => r.id === a.reason)?.id;
  if (!reason) return { ok: false, error: "Pick the reason that fits best." };
  const detail = (a.detail ?? "").trim().slice(0, 2000) || null;
  if (reason === "other" && (!detail || detail.length < 3)) {
    return { ok: false, error: "Say a few words about why, so the answer is useful." };
  }
  return { ok: true, reason, detail };
}

/**
 * The confirmation sentence. It names the date when there is one; when the
 * period end is unknown it says "the end of the current billing period"
 * rather than inventing a day.
 */
export function cancellationSummary(periodEnd: string | null | undefined): string {
  const when = periodEnd
    ? new Date(periodEnd).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "the end of the current billing period";
  return `You keep access until ${when}. Your articles stay readable and exportable afterwards.`;
}
