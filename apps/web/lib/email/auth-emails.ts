// Auth emails, sent by us.
//
// Supabase Auth can send confirm / reset / magic-link emails itself, from
// templates pasted into its dashboard. That is state outside the repository,
// owned by whoever last clicked Save, and on 2026-09-02 it shipped the stock
// template twice after the branded one was believed to be in. So the app
// sends these itself: the link is generated with the service role
// (`auth.admin.generateLink`), wrapped in the same layout as every other email
// we send, and delivered through Resend. Supabase's own mailer is never
// triggered, because nothing here calls `auth.signUp` or
// `resetPasswordForEmail`.
//
// The link points at our /callback with a token hash; the callback verifies
// it server-side (`verifyOtp`) and sets the session. No PKCE cookie is
// needed, so the link works in whichever browser opens it.

import { createServiceClient } from "@/lib/supabase/server";
import { sendToolResultEmail } from "@/lib/email/resend";
import { emailButton, emailParagraph, EMAIL_INK, EMAIL_INK_3 } from "@/lib/email/layout";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3100";

export type AuthLinkType = "signup" | "recovery" | "magiclink";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The URL the email carries: our callback, which verifies the hash. */
export function authLink(type: AuthLinkType, hashedToken: string, next: string): string {
  const u = new URL("/callback", APP_URL);
  u.searchParams.set("token_hash", hashedToken);
  u.searchParams.set("type", type);
  u.searchParams.set("next", next);
  return u.toString();
}

function fallbackLine(url: string): string {
  return `<p style="margin:0 0 14px;font-size:12px;line-height:1.6;color:${EMAIL_INK_3};word-break:break-all;">If the button does not work, paste this into your browser:<br>${esc(url)}</p>`;
}

export function renderConfirmSignup(url: string, email: string) {
  return {
    subject: "Confirm your AltoRank account",
    html:
      `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:${EMAIL_INK};">Confirm your email</h1>` +
      emailParagraph("One click and your account is live. Your workspace is already set up; the first thing you will see is what your site ranks for.") +
      emailButton(url, "Confirm my email") +
      emailParagraph("The link expires in 24 hours. Nothing is charged: there is no trial and no card on file until you choose a plan.") +
      fallbackLine(url) +
      `<p style="margin:0;font-size:12px;color:${EMAIL_INK_3};">Sent to ${esc(email)} because an account was created on AltoRank with this address. If that was not you, ignore this email.</p>`,
  };
}

export function renderPasswordReset(url: string, email: string) {
  return {
    subject: "Reset your AltoRank password",
    html:
      `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:${EMAIL_INK};">Reset your password</h1>` +
      emailParagraph("Someone asked to reset the password for this AltoRank account. If it was you, set a new one below.") +
      emailButton(url, "Choose a new password") +
      emailParagraph("The link works once and expires in one hour. If you did not ask for this, your password is unchanged and you can ignore this email.") +
      fallbackLine(url) +
      `<p style="margin:0;font-size:12px;color:${EMAIL_INK_3};">Sent to ${esc(email)} because a password reset was requested on AltoRank.</p>`,
  };
}

export function renderMagicLink(url: string, email: string) {
  return {
    subject: "Your AltoRank sign-in link",
    html:
      `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:${EMAIL_INK};">Sign in to AltoRank</h1>` +
      emailParagraph("Here is your one-time sign-in link. No password needed.") +
      emailButton(url, "Sign in") +
      emailParagraph("The link works once and expires in one hour. If you did not request it, ignore this email; nobody can sign in without it.") +
      fallbackLine(url) +
      `<p style="margin:0;font-size:12px;color:${EMAIL_INK_3};">Sent to ${esc(email)} because a sign-in link was requested on AltoRank.</p>`,
  };
}

/**
 * Create the user (unconfirmed) and email the confirmation link.
 * Returns the new user's id, or throws with a message safe to show.
 */
export async function sendSignupConfirmation(opts: { email: string; password: string; name: string }): Promise<string> {
  const admin = createServiceClient();
  // `signup` creates the user when it does not exist and returns the token
  // for the confirmation link; no email leaves Supabase.
  const { data, error } = await admin.auth.admin.generateLink({
    type: "signup",
    email: opts.email,
    password: opts.password,
    options: { data: { name: opts.name } },
  });
  if (error || !data.user) throw new Error(error?.message ?? "Could not create the account");

  const url = authLink("signup", data.properties.hashed_token, "/dashboard");
  const { subject, html } = renderConfirmSignup(url, opts.email);
  await sendToolResultEmail(opts.email, subject, html);
  return data.user.id;
}

/**
 * Email a password-reset link. Silent when the address has no account: the
 * caller shows the same "if that account exists" message either way.
 */
export async function sendPasswordReset(email: string): Promise<boolean> {
  const admin = createServiceClient();
  const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email });
  if (error || !data.properties?.hashed_token) return false;
  const url = authLink("recovery", data.properties.hashed_token, "/reset-password/confirm");
  const { subject, html } = renderPasswordReset(url, email);
  await sendToolResultEmail(email, subject, html);
  return true;
}

/** Email a one-time sign-in link. Silent when the address has no account. */
export async function sendMagicLink(email: string): Promise<boolean> {
  const admin = createServiceClient();
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.hashed_token) return false;
  const url = authLink("magiclink", data.properties.hashed_token, "/dashboard");
  const { subject, html } = renderMagicLink(url, email);
  await sendToolResultEmail(email, subject, html);
  return true;
}
