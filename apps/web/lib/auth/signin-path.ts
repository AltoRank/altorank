// ---------------------------------------------------------------------------
// The sign-in pages' addresses, with `next` carried along
// ---------------------------------------------------------------------------
//
// Code signup (#287) gives every new account a random password nobody ever
// sees, and an email link opened without a session lands on /signin. So
// /signin asks for a code first and keeps the password one tap away
// (`?method=password` opens it directly: an account that signs in with a
// password, a reviewer's among them, has a stable URL for it).
//
// Client-safe: strings only.

export const SIGNIN_METHODS = ["code", "password"] as const;
export type SignInMethod = (typeof SIGNIN_METHODS)[number];

/** The form /signin opens on: the code, unless the URL asks for the password. */
export function signInMethod(raw: unknown): SignInMethod {
  return raw === "password" ? "password" : "code";
}

/** A sign-in page's address with `next` (already validated) and anything else it needs. */
export function signinPath(path: "/signin" | "/signin/code", next: string | null, extra?: Record<string, string>): string {
  const q = new URLSearchParams(extra);
  if (next) q.set("next", next);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** What /callback says when an emailed link no longer works, on the page that can send a new one. */
export const EXPIRED_LINK_MESSAGE = "That link has expired. We can email you a new code.";

/** What a sign-in code request says when the email did not go out. */
export const CODE_NOT_SENT = "The code could not be sent. Try again in a minute.";
