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
import { billingEnabled } from "@/lib/stripe";
import { trialGateBypassed } from "@/lib/billing/trial";
import { AddressTakenError, isAddressTakenRefusal } from "@/lib/auth/address-taken";



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

/**
 * The confirmation email.
 *
 * `beforeTrial` is whether this signup will meet the trial gate
 * (lib/billing/trial.ts). Behind it, onboarding writes one article
 * (PRE_TRIAL_DRAFTS in lib/billing/trial-hold.ts) and shows its title,
 * outline and sources; the text itself is withheld until the trial starts
 * (`draftBodyLocked`). This used to promise "until you have read your first
 * drafts", which is two things the gate does not do. On an install with no
 * billing, or with the gate off, nobody is asked for a card, so the line is
 * left out.
 *
 * The link lifetime is the Supabase email OTP lifetime, `otp_expiry = 3600`
 * in supabase/config.toml: one hour, the same as the reset and sign-in links.
 * This said 24 hours.
 */
export function renderConfirmSignup(url: string, email: string, opts: { beforeTrial?: boolean; code?: string | null } = {}) {
  const code = opts.code ?? null;
  const expiry = opts.beforeTrial
    ? "The link expires in one hour. No card is asked for until you have seen your first article's title, outline and sources. The full text opens with the trial."
    : "The link expires in one hour.";
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
      emailParagraph(expiry) +
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

export function renderMagicLink(url: string, email: string, code?: string | null) {
  return {
    footerNote: `Sent to ${email} because a sign-in link was requested on AltoRank.`,
    subject: code ? `${code} is your AltoRank sign-in code` : "Your AltoRank sign-in link",
    html:
      `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:${EMAIL_INK};">Sign in to AltoRank</h1>` +
      (code
        ? emailParagraph("Type this code on the sign-in page:") +
          `<p style="margin:0 0 18px;font-family:ui-monospace,Menlo,monospace;font-size:28px;letter-spacing:6px;font-weight:600;color:${EMAIL_INK};">${esc(code)}</p>` +
          emailParagraph("Or sign in with one click:")
        : emailParagraph("Here is your one-time sign-in link. No password needed.")) +
      emailButton(url, "Sign in") +
      emailParagraph("The link works once and expires in one hour. If you did not request it, ignore this email; nobody can sign in without it.") +
      fallbackLine(url),
  };
}

/**
 * `generateLink({ type: "recovery" })` for an address with no account fails
 * with `user_not_found`. A magic link does NOT: Supabase creates the user and
 * returns a signup link instead (see `sendSignInCode`). The not-found answer
 * stays silent on purpose: the request form shows the same message either
 * way, so it cannot be used to find out which addresses have accounts.
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
export async function sendSignupConfirmation(opts: {
  email: string;
  password?: string;
  /** A name the person typed themselves (the invite join form). Never one made from a domain. */
  name?: string;
  next?: string;
  /** Set for an invited teammate: the account they are joining. They get no site of their own, so the owner wording would be wrong. */
  invitedTo?: string;
}): Promise<string> {
  const admin = createServiceClient();
  // `signup` creates the user when it does not exist and returns the token
  // for the confirmation link; no email leaves Supabase.
  //
  // No `name` in the user metadata. The form asks for none, and what used to
  // go here was the account name made from the domain, which every email that
  // names a person then read back as theirs: "You are in, Acme" and "Acme
  // approved this draft" (callback/route.ts, approval-events.ts `actorName`).
  // With no name those fall back to the address, which is the person. A name
  // the person typed (an invitee on the join form) is theirs, so it is kept.
  const name = opts.name?.trim();
  const { data, error } = await admin.auth.admin.generateLink({
    type: "signup",
    email: opts.email,
    // Signup asks for no password since the code was added: the person signs
    // in with a code or a link, and this random one is never shown or used.
    // Supabase's signup link still needs one to create the user.
    password: opts.password || randomPassword(),
    ...(name ? { options: { data: { name } } } : {}),
  });
  // A confirmed address is refused; the signup form offers that person a
  // sign-in code rather than the refusal (lib/auth/address-taken.ts).
  if (error && isAddressTakenRefusal(error)) throw new AddressTakenError(error.message);
  if (error || !data.user) throw new Error(error?.message ?? "Could not create the account");

  const url = authLink("signup", data.properties.hashed_token, opts.next ?? "/dashboard");
  // A new signup has no plan and has not had a trial, so it meets the gate
  // unless billing is off, the gate is switched off, or the address is exempt.
  // An invitee joins someone else's account and never meets the gate.
  const beforeTrial = billingEnabled && process.env.TRIAL_GATE_DISABLED !== "1" && !trialGateBypassed(opts.email);
  const { subject, html, footerNote } =
    opts.invitedTo !== undefined
      ? renderConfirmInvite(url, opts.email, opts.invitedTo)
      : // The same confirmation as the link, as a code the signup page takes in
        // the tab the person never left (app/(auth)/signup/verify).
        renderConfirmSignup(url, opts.email, { beforeTrial, code: data.properties.email_otp || null });
  try {
    await sendTransactionalEmail(
      opts.email,
      subject,
      html,
      footerNote,
      opts.invitedTo !== undefined ? "Confirm your email to join your team." : "One click and your account is live.",
    );
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

/** What `sendSignInCode` did: whether a code left, and the user it had to create. */
export interface SignInCodeResult {
  sent: boolean;
  /**
   * Set when the address had no user and Supabase created one to send the
   * code to: a signup, by the sign-in door (lib/auth/signin-code-signup.ts).
   */
  createdUserId: string | null;
}

/**
 * Email a one-time sign-in code, with the link beside it, for accounts made
 * without a password (signup asks for a code since 2026-10-15). Throws on a
 * configuration failure.
 *
 * For an address with no user, Supabase's magic link does not fail with
 * `user_not_found` as the reset does: it creates the user and returns a
 * signup link (`verification_type: "signup"`) whose code signs them in. So
 * "Email me a sign-in code" was a signup door that skipped the domain
 * question and left no `signup` event - a real signup came in that way on
 * 2026-10-19 and landed with no site. The new user is reported back so the
 * caller can make it a signup on purpose; the form still says the same thing
 * either way.
 */
export async function sendSignInCode(email: string, next: string): Promise<SignInCodeResult> {
  const admin = createServiceClient();
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) {
    if (isUserNotFound(error)) return { sent: false, createdUserId: null };
    throw new Error(`Could not generate the sign-in code: ${error.message}`);
  }
  const createdUserId = data.properties?.verification_type === "signup" ? (data.user?.id ?? null) : null;
  const token = data.properties?.hashed_token;
  if (!token) throw new Error("Supabase returned a sign-in link without a token hash");
  const url = authLink("magiclink", token, next);
  const { subject, html, footerNote } = renderMagicLink(url, email, data.properties?.email_otp || null);
  try {
    await sendTransactionalEmail(email, subject, html, footerNote, "Your one-time sign-in code.");
  } catch (e) {
    // A user made only to receive this code, and the code never left: undo
    // it, as signup does, so the next try starts clean.
    if (createdUserId) await rollbackUnsentSignup(createdUserId);
    throw e;
  }
  return { sent: true, createdUserId };
}

/**
 * The confirmation for a teammate who was invited. They join an account that
 * already exists, so there is no site of theirs to mention and no trial of
 * theirs to promise.
 */
export function renderConfirmInvite(url: string, email: string, accountName: string) {
  return {
    footerNote: `Sent to ${email} because a login was created on AltoRank from an invitation to this address. If that was not you, ignore this email.`,
    subject: `Confirm your email to join ${accountName} on AltoRank`,
    html:
      `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:${EMAIL_INK};">Confirm your email</h1>` +
      emailParagraph(`Confirm this address to finish joining ${esc(accountName)} on AltoRank. The link signs you in and accepts the invitation.`) +
      emailButton(url, "Confirm and join") +
      emailParagraph("The link works once and expires in one hour.") +
      fallbackLine(url),
  };
}
