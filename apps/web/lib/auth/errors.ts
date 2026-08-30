// ---------------------------------------------------------------------------
// Human-readable auth errors
// ---------------------------------------------------------------------------
//
// Supabase surfaces transport failures as whatever the runtime threw, so when
// the auth service is unreachable the sign-up form renders the literal string
// "fetch failed". That tells the user nothing, and it reads as a bug in the
// form rather than as the service being down: the reasonable next move looks
// like "try a different email", which never helps.
//
// Reported from a real sign-up attempt while the local Supabase container was
// stopped.

/** Transport-level failures, which mean the service is unreachable. */
const UNREACHABLE = [
  "fetch failed",
  "econnrefused",
  "enotfound",
  "econnreset",
  "network request failed",
  "socket hang up",
  "and_timeout",
  "etimedout",
];

export function authErrorMessage(raw: string | undefined | null): string {
  const message = (raw ?? "").trim();
  if (!message) return "Something went wrong. Please try again.";

  const lower = message.toLowerCase();

  if (UNREACHABLE.some((needle) => lower.includes(needle))) {
    // Deliberately says what to check. Self-hosters hit this constantly when
    // their database container is not running, and the generic phrasing sent
    // them looking at their credentials instead.
    return (
      "Cannot reach the authentication service. If you are running AltoRank " +
      "locally, check that Supabase is started; otherwise the service may be " +
      "temporarily unavailable."
    );
  }

  // Supabase's own messages are already written for end users.
  return message;
}
