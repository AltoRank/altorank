/**
 * Where in-app feedback and integration requests go: `FEEDBACK_EMAIL`, and
 * nowhere when it is unset.
 *
 * Both routes used to fall back to a hard-coded AltoRank inbox. On any install
 * of this repo that forgot the variable, that mailed the install's users'
 * addresses, account ids, sites and dashboard screenshots to a mailbox outside
 * the install. An unset variable means nobody on this deployment has said
 * where these should go, so the honest answer is to send nothing and say why,
 * the same rule `operatorRecipients()` follows for operator mail.
 *
 * Read at call time so a test, or a runtime that injects env late, sees the
 * current value.
 */
export function feedbackRecipient(): string | null {
  const configured = process.env.FEEDBACK_EMAIL?.trim();
  return configured ? configured : null;
}

/** The 503 body both routes return when there is no recipient. */
export const NO_FEEDBACK_RECIPIENT =
  "This deployment has no address for feedback or requests (FEEDBACK_EMAIL is not set).";
