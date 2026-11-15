// ---------------------------------------------------------------------------
// The link in a follow-up email that answers "what stopped you?"
// ---------------------------------------------------------------------------
//
// Public and sessionless, on the terms /hold and /unsubscribe are: the HMAC
// binds the site to the address the mail went to, so the link cannot answer
// for a site its holder is not on. The page it opens only asks; the answer is
// written by its button's POST (app/why), because mail scanners fetch every
// link in a message before anyone reads it.

import crypto from "node:crypto";
import { appUrl } from "@/lib/app-url";
import { isGateReason } from "@/lib/onboarding/gate-answer";
import type { GateReason } from "@/lib/onboarding/step-props";

function secret(): string | null {
  return process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}

export function signWhy(workspaceId: string, email: string): string | null {
  const key = secret();
  if (!key) return null;
  return crypto.createHmac("sha256", key).update(`why|${workspaceId}|${email.trim().toLowerCase()}`).digest("hex").slice(0, 32);
}

/** Constant-time compare, so a wrong signature does not leak how wrong it was. */
export function verifyWhy(workspaceId: string, email: string, signature: string): boolean {
  const expected = signWhy(workspaceId, email);
  if (!expected || signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** The URL for one recipient, with a reason already picked when the mail's link named one; null with no secret. */
export function whyUrl(workspaceId: string, email: string, reason?: GateReason): string | null {
  const sig = signWhy(workspaceId, email);
  if (!sig) return null;
  const u = new URL("/why", appUrl());
  u.searchParams.set("w", workspaceId);
  u.searchParams.set("e", email.trim().toLowerCase());
  u.searchParams.set("s", sig);
  if (reason) u.searchParams.set("r", reason);
  return u.toString();
}

export type WhyParams = { ok: true; workspaceId: string; email: string; reason: GateReason | null } | { ok: false; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readWhyParams(params: URLSearchParams): WhyParams {
  const workspaceId = params.get("w") ?? "";
  const email = (params.get("e") ?? "").trim().toLowerCase();
  const sig = params.get("s") ?? "";
  if (!UUID.test(workspaceId) || !email.includes("@") || !sig) return { ok: false, reason: "The link is incomplete." };
  if (!verifyWhy(workspaceId, email, sig)) return { ok: false, reason: "The link’s signature does not match. It may have been altered or cut short." };
  const r = params.get("r");
  return { ok: true, workspaceId, email, reason: isGateReason(r) ? r : null };
}
