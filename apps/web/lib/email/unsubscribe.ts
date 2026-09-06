// ---------------------------------------------------------------------------
// The unsubscribe link, and the signature that makes it safe to hand out
// ---------------------------------------------------------------------------
//
// The link has to work for somebody who is not signed in - that is the whole
// point of it - so the address and the category travel in the URL. Unsigned,
// that URL is a form anybody can fill in to silence anybody else's drafts and
// reports. The signature binds the two parameters to a secret only the server
// holds; a link with a different address in it does not verify.
//
// The secret is the service-role key by default. Nothing derived from it
// leaves the server except a 32-hex-character HMAC, which does not reveal it,
// and reusing it avoids a second required variable on a deployment that is
// already several short. EMAIL_UNSUBSCRIBE_SECRET overrides it where an
// operator would rather rotate the two separately.
//
// When neither is set the link is simply not rendered: an unsubscribe link
// that cannot be honoured is worse than none.

import crypto from "node:crypto";
import { appUrl } from "./app-url";
import { ALL_OPTIONAL, isEmailCategory, type EmailCategory } from "./categories";

function secret(): string | null {
  return (
    process.env.EMAIL_UNSUBSCRIBE_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    null
  );
}

export function signUnsubscribe(email: string, category: string): string | null {
  const key = secret();
  if (!key) return null;
  return crypto
    .createHmac("sha256", key)
    .update(`${email.trim().toLowerCase()}|${category}`)
    .digest("hex")
    .slice(0, 32);
}

/** Constant-time compare, so a wrong signature does not leak how wrong it was. */
export function verifyUnsubscribe(email: string, category: string, signature: string): boolean {
  const expected = signUnsubscribe(email, category);
  if (!expected || signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * The one-click URL for an address and a category, or null when the category
 * is required or no secret is configured.
 *
 * `category` may be a single category or ALL_OPTIONAL for "stop all of the
 * optional ones", which is what the preferences page offers.
 */
export function unsubscribeUrl(email: string, category: EmailCategory | typeof ALL_OPTIONAL): string | null {
  const sig = signUnsubscribe(email, category);
  if (!sig) return null;
  const u = new URL("/unsubscribe", appUrl());
  u.searchParams.set("e", email.trim().toLowerCase());
  u.searchParams.set("c", category);
  u.searchParams.set("s", sig);
  return u.toString();
}

/** The same target, as the POST endpoint mail clients call for one-click. */
export function unsubscribePostUrl(email: string, category: EmailCategory | typeof ALL_OPTIONAL): string | null {
  const link = unsubscribeUrl(email, category);
  return link ? link.replace("/unsubscribe?", "/api/unsubscribe?") : null;
}

/**
 * The List-Unsubscribe pair (RFC 8058). A mail client that shows its own
 * "unsubscribe" button uses these, and Gmail requires them of any sender doing
 * volume - which we are not yet, but the header costs nothing and the
 * alternative is the recipient pressing "spam" instead.
 */
export function unsubscribeHeaders(
  email: string,
  category: EmailCategory | typeof ALL_OPTIONAL,
): Record<string, string> | undefined {
  const post = unsubscribePostUrl(email, category);
  if (!post) return undefined;
  return {
    "List-Unsubscribe": `<${post}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/** Parse and verify the three parameters a link carries. */
export function readUnsubscribeParams(params: URLSearchParams):
  | { ok: true; email: string; category: EmailCategory | typeof ALL_OPTIONAL }
  | { ok: false; reason: string } {
  const email = (params.get("e") ?? "").trim().toLowerCase();
  const category = params.get("c") ?? "";
  const signature = params.get("s") ?? "";
  if (!email || !category || !signature) return { ok: false, reason: "That link is incomplete." };
  if (category !== ALL_OPTIONAL && !isEmailCategory(category)) {
    return { ok: false, reason: "That link names a kind of email we do not send." };
  }
  if (!verifyUnsubscribe(email, category, signature)) {
    return { ok: false, reason: "That link could not be verified. It may have been cut short by your email client." };
  }
  return { ok: true, email, category: category as EmailCategory | typeof ALL_OPTIONAL };
}
