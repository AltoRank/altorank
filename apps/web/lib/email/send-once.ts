// ---------------------------------------------------------------------------
// Send this email once, to the people who still want it
// ---------------------------------------------------------------------------
//
// Every lifecycle trigger in this product can fire twice for the same fact.
// Stripe retries a webhook until it gets a 200 and raises a fresh
// `invoice.payment_failed` on every card retry for days; the generate cron
// runs four times a day; the publish cron runs every fifteen minutes; a server
// action can be double-submitted. A duplicate transactional email is not a
// mailing-list annoyance - it reads as the product being broken, and for a
// dunning notice it reads as being shouted at.
//
// So a send is claimed in `sent_emails` (migration 072) *before* it leaves,
// keyed by (type, subject, recipient), and the claim is deleted again if the
// send fails. Claim-then-send rather than send-then-record because the failure
// that matters is a second run starting while the first is still inside the
// Resend call, and only the claim closes that window. A crash between the
// claim and a successful send costs one missed notification; the other order
// costs a duplicate on every retry.
//
// The other job here is the wish not to be told. Optional categories
// (lib/email/categories.ts) are filtered against `email_preferences` and carry
// an unsubscribe link and the RFC 8058 headers; required ones are sent
// regardless, and say why in the footer instead.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendTransactionalEmail } from "./resend";
import { isOptional, wantsCategory, type EmailCategory } from "./categories";
import { unsubscribeHeaders, unsubscribeUrl } from "./unsubscribe";

export type LifecycleMeta = {
  /** Stable slug, e.g. "article_published". Never a subject line. */
  type: string;
  /** What the email is about: an article id, an agency id plus a timestamp, … */
  subjectId: string;
  category: EmailCategory;
  agencyId?: string | null;
  workspaceId?: string | null;
};

export type RenderedEmail = {
  subject: string;
  html: string;
  preheader?: string;
  footerNote: string;
};

export type SendOnceOutcome = {
  sent: number;
  /** Already sent to this address, or the address opted out of the category. */
  skipped: number;
  failed: number;
  lastError?: string;
};

const UNIQUE_VIOLATION = "23505";

/** Lowercased, deduplicated, and with anything that is not an address dropped. */
export function normalizeRecipients(to: readonly (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const raw of to) {
    const email = raw?.trim().toLowerCase();
    if (email && email.includes("@")) out.add(email);
  }
  return [...out];
}

/** The addresses among these that have opted out of the category. */
async function optedOut(
  supabase: SupabaseClient,
  recipients: string[],
  category: EmailCategory,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!isOptional(category) || recipients.length === 0) return out;
  const { data, error } = await supabase
    .from("email_preferences")
    .select("email, unsubscribed")
    .in("email", recipients);
  // A preferences table that cannot be read must not silence the mail: the
  // default state is "wants it", and every row we could not read is a row that
  // is almost certainly empty.
  if (error) {
    console.error(`[email] could not read preferences: ${error.message}`);
    return out;
  }
  for (const row of data ?? []) {
    if (!wantsCategory(row.unsubscribed as string[] | null, category)) out.add(row.email as string);
  }
  return out;
}

/**
 * Send one lifecycle email to several people, at most once each.
 *
 * Never throws. Every one of these is announced *after* the work it announces
 * is already done and recorded, and a mail provider being unreachable must not
 * turn a published article or a processed webhook into a failure somebody has
 * to investigate. The outcome is returned for the caller to log.
 */
export async function sendOnce(
  supabase: SupabaseClient,
  to: readonly (string | null | undefined)[],
  meta: LifecycleMeta,
  render: (recipient: string) => RenderedEmail,
): Promise<SendOnceOutcome> {
  const recipients = normalizeRecipients(to);
  const out: SendOnceOutcome = { sent: 0, skipped: 0, failed: 0 };
  if (recipients.length === 0) return out;

  const declined = await optedOut(supabase, recipients, meta.category);

  for (const recipient of recipients) {
    if (declined.has(recipient)) {
      out.skipped += 1;
      continue;
    }

    const { error: claimError } = await supabase.from("sent_emails").insert({
      email_type: meta.type,
      subject_id: meta.subjectId,
      recipient,
      agency_id: meta.agencyId ?? null,
      workspace_id: meta.workspaceId ?? null,
    });

    if (claimError) {
      if (claimError.code === UNIQUE_VIOLATION) {
        out.skipped += 1;
      } else {
        // The ledger is the only thing standing between a retried webhook and
        // a week of duplicate notices, so a ledger we cannot write is a reason
        // not to send, not a reason to send anyway.
        out.failed += 1;
        out.lastError = `could not claim the send: ${claimError.message}`;
        console.error(`[email] ${meta.type} to ${recipient}: ${out.lastError}`);
      }
      continue;
    }

    try {
      const body = render(recipient);
      await sendTransactionalEmail(recipient, body.subject, body.html, body.footerNote, body.preheader, {
        headers: unsubscribeHeadersFor(recipient, meta.category),
        unsubscribeUrl: unsubscribeLinkFor(recipient, meta.category),
      });
      out.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      out.failed += 1;
      out.lastError = message;
      console.error(`[email] ${meta.type} to ${recipient} failed: ${message}`);
      // Release the claim so the next run can try again. A failure to release
      // is only a missed notification, so it is logged and not raised.
      const { error: releaseError } = await supabase
        .from("sent_emails")
        .delete()
        .eq("email_type", meta.type)
        .eq("subject_id", meta.subjectId)
        .eq("recipient", recipient);
      if (releaseError) {
        console.error(`[email] could not release the claim for ${meta.type}/${recipient}: ${releaseError.message}`);
      }
    }
  }

  return out;
}

function unsubscribeLinkFor(recipient: string, category: EmailCategory): string | null {
  return isOptional(category) ? unsubscribeUrl(recipient, category) : null;
}

function unsubscribeHeadersFor(recipient: string, category: EmailCategory): Record<string, string> | undefined {
  return isOptional(category) ? unsubscribeHeaders(recipient, category) : undefined;
}

/** One line for a cron's JSON, so a run says what it told whom. */
export function describeSendOutcome(out: SendOnceOutcome): string {
  const parts: string[] = [];
  if (out.sent) parts.push(`emailed ${out.sent}`);
  if (out.skipped) parts.push(`${out.skipped} already told or opted out`);
  if (out.failed) parts.push(`${out.failed} failed (${out.lastError ?? "unknown"})`);
  return parts.length ? parts.join(", ") : "nobody to email";
}
