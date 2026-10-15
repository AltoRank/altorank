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

import type { AuthError } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { sendTransactionalEmail } from "@/lib/email/resend";
import { emailButton, emailParagraph, EMAIL_INK, EMAIL_INK_3 } from "@/lib/email/layout";
import { appUrl } from "@/lib/app-url";



export type AuthLinkType = "signup" | "recovery" | "magiclink";

/** A password nobody will type: 32 random bytes, base64url. */
function randomPassword(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The URL the email carries: our callback, which verifies the hash. */
export function authLink(type: AuthLinkType, hashedToken: string, next: string): string {
  const u = new URL("/callback", appUrl());
  u.searchParams.set("token_hash", hashedToken);
  u.searchParams.set("type", type);
  u.searchParams.set("next", next);
  return u.toString();
}

function fallbackLine(url: string): string {
  return `<p style="margin:0 0 14px;font-size:12px;line-height:1.6;color:${EMAIL_INK_3};word-break:break-all;">If the button does not work, paste this into your browser:<br>${esc(url)}</p>`;
}

export function renderConfirmSignup(url: string, email: string, code?: string | null) {
  // The code first when there is one: the signup page is waiting for it, in
  // the tab the person is still on. The link stays for another device.
  const codeBlock = code
    ? `<p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:${EMAIL_INK_3};">Your code</p>` +
      `<p style="margin:0 0 18px;font-family:ui-monospace,Menlo,monospace;font-size:28px;letter-spacing:6px;font-weight:600;color:${EMAIL_INK};">${esc(code)}</p>`
    : "";
  return {
    footerNote: `Sent to ${email} because an account was created on AltoRank with this address. If that was not you, ignore this email.`,
    subject: code ? `${code} is your AltoRank code` : "Confirm your AltoRank account",
    html:
      `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:${EMAIL_INK};">Confirm your email</h1>` +
      (code
        ? emailParagraph("Type this code on the signup page to carry on. Your workspace is already set up.") + codeBlock + emailParagraph("Or confirm with one click on any device:")
        : emailParagraph("One click and your account is live. Your workspace is already set up; the first thing you will see is what your site ranks for.")) +
      emailButton(url, "Confirm my email") +
      emailParagraph("The link expires in 24 hours. Nothing is charged and no card is asked for until you have read your first drafts.") +
      fallbackLine(url),
  };
}

export function renderPasswordReset(url: string, email: string) {
  return {
    footerNote: `Sent to ${email} because a password reset was requested on AltoRank.`,
    subject: "Reset your AltoRank password",
    html:
      `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:${EMAIL_INK};">Reset your password</h1>` +
      emailParagraph("Someone asked to reset the password for this AltoRank account. If it was you, set a new one below.") +
      emailButton(url, "Choose a new password") +
      emailParagraph("The link works once and expires in one hour. If you did not ask for this, your password is unchanged and you can ignore this email.") +
      fallbackLine(url),
  };
}

export function renderMagicLink(url: string, email: string) {
  return {
    footerNote: `Sent to ${email} because a sign-in link was requested on AltoRank.`,
    subject: "Your AltoRank sign-in link",
    html:
      `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:${EMAIL_INK};">Sign in to AltoRank</h1>` +
      emailParagraph("Here is your one-time sign-in link. No password needed.") +
      emailButton(url, "Sign in") +
      emailParagraph("The link works once and expires in one hour. If you did not request it, ignore this email; nobody can sign in without it.") +
      fallbackLine(url),
  };
}

/**
 * `generateLink` for an address with no account fails with `user_not_found`.
 * That one stays silent on purpose: the request form shows the same message
 * either way, so it cannot be used to find out which addresses have accounts.
 * Everything else, such as a missing or wrong service-role key or Supabase
 * being unreachable, is a configuration failure. Swallowing those too is what
 * hid the broken reset flow on 2026-09-02, so they are thrown and reach the
 * server log.
 */
function isUserNotFound(error: AuthError): boolean {
  return error.code === "user_not_found" || /user not found/i.test(error.message);
}

/** Token hash for a one-time link; null when the address has no account. */
async function tokenHashFor(type: "recovery", email: string): Promise<string | null> {
  const admin = createServiceClient();
  const { data, error } = await admin.auth.admin.generateLink({ type, email });
  if (error) {
    if (isUserNotFound(error)) return null;
    throw new Error(`Could not generate the ${type} link: ${error.message}`);
  }
  const token = data.properties?.hashed_token;
  if (!token) throw new Error(`Supabase returned a ${type} link without a token hash`);
  return token;
}

/**
 * Create the user (unconfirmed) and email the confirmation link.
 * Returns the new user's id, or throws with a message safe to show.
 */
export async function sendSignupConfirmation(opts: { email: string; password?: string; name: string; next?: string }): Promise<string> {
  const admin = createServiceClient();
  // `signup` creates the user when it does not exist and returns the token
  // for the confirmation link; no email leaves Supabase.
  const { data, error } = await admin.auth.admin.generateLink({
    type: "signup",
    email: opts.email,
    // Signup asks for no password since the code was added: the person signs
    // in with a code or a link, and this random one is never shown or used.
    // Supabase's signup link still needs one to create the user.
    password: opts.password || randomPassword(),
    options: { data: { name: opts.name } },
  });
  if (error || !data.user) throw new Error(error?.message ?? "Could not create the account");

  const url = authLink("signup", data.properties.hashed_token, opts.next ?? "/dashboard");
  // The same confirmation as the link, as a code the signup page takes in
  // the tab the person never left (app/(auth)/signup/verify).
  const { subject, html, footerNote } = renderConfirmSignup(url, opts.email, data.properties.email_otp || null);
  try {
    await sendTransactionalEmail(opts.email, subject, html, footerNote, "One click and your account is live.");
  } catch (e) {
    // The user exists by now and the link that would confirm them never left.
    // Left alone, the next attempt is refused as "already registered" and
    // there is no resend path, so the address is locked out for good. Undo
    // the creation and say so; the retry then starts clean.
    console.error(`[signup] confirmation email to ${opts.email} failed: ${e instanceof Error ? e.message : String(e)}`);
    await rollbackUnsentSignup(data.user.id);
    throw new Error("We could not send the confirmation email, so the account was not created. Please try again in a minute.");
  }
  return data.user.id;
}

/**
 * Delete an auth user whose confirmation email was never sent, unless they
 * already hold a membership. `generateLink({type:"signup"})` also returns an
 * existing *unconfirmed* user, and one with an account was set up on an
 * earlier attempt whose email did go out; deleting them would orphan that
 * account. Never throws: the caller is already reporting the send failure.
 */
async function rollbackUnsentSignup(userId: string): Promise<void> {
  const admin = createServiceClient();
  try {
    const { count, error } = await admin
      .from("account_members")
      .select("account_id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    if ((count ?? 0) > 0) {
      console.warn(`[signup] user ${userId} kept: already a member of an account`);
      return;
    }
    const { error: delError } = await admin.auth.admin.deleteUser(userId);
    if (delError) throw new Error(delError.message);
  } catch (e) {
    console.error(`[signup] could not roll back user ${userId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Email a password-reset link. Resolves false, silently, when the address has
 * no account: the caller shows the same "if that account exists" message
 * either way. Throws when the link could not be generated or the email was
 * refused, so the caller can log the real reason.
 */
export async function sendPasswordReset(email: string): Promise<boolean> {
  const token = await tokenHashFor("recovery", email);
  if (!token) return false;
  const url = authLink("recovery", token, "/reset-password/confirm");
  const { subject, html, footerNote } = renderPasswordReset(url, email);
  await sendTransactionalEmail(email, subject, html, footerNote, "Set a new password in one click.");
  return true;
}
