// ---------------------------------------------------------------------------
// The Hold link in the drafted email, and the signature that makes it safe
// ---------------------------------------------------------------------------
//
// A workspace that publishes automatically sends "this ships after <time>
// unless you hold it". The hold has to work from the inbox, without a session:
// the whole point is that the person can stop it from their phone in the
// minute they read the mail. So the article id and the recipient travel in the
// URL, bound together by an HMAC over a server secret, exactly as the
// unsubscribe link does (lib/email/unsubscribe.ts). A link with a different
// article or address in it does not verify, so this cannot be used to hold
// drafts on an account the holder is not on.
//
// The recipient is in the signature because the hold is recorded against a
// person (`articles.held_by`): the same accountability the approval carries.

import crypto from "node:crypto";
import { appUrl } from "@/lib/app-url";

function secret(): string | null {
  return process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}

export function signHold(articleId: string, email: string): string | null {
  const key = secret();
  if (!key) return null;
  return crypto
    .createHmac("sha256", key)
    .update(`hold|${articleId}|${email.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}

/** Constant-time compare, so a wrong signature does not leak how wrong it was. */
export function verifyHold(articleId: string, email: string, signature: string): boolean {
  const expected = signHold(articleId, email);
  if (!expected || signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** The one-click hold URL for one recipient, or null when no secret is configured. */
export function holdUrl(articleId: string, email: string): string | null {
  const sig = signHold(articleId, email);
  if (!sig) return null;
  const u = new URL("/hold", appUrl());
  u.searchParams.set("a", articleId);
  u.searchParams.set("e", email.trim().toLowerCase());
  u.searchParams.set("s", sig);
  return u.toString();
}

export type HoldParams =
  | { ok: true; articleId: string; email: string }
  | { ok: false; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readHoldParams(params: URLSearchParams): HoldParams {
  const articleId = params.get("a") ?? "";
  const email = (params.get("e") ?? "").trim().toLowerCase();
  const sig = params.get("s") ?? "";
  if (!UUID.test(articleId) || !email.includes("@") || !sig) {
    return { ok: false, reason: "The link is incomplete." };
  }
  if (!verifyHold(articleId, email, sig)) {
    return { ok: false, reason: "The link's signature does not match. It may have been altered or truncated." };
  }
  return { ok: true, articleId, email };
}
