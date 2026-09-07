import { Resend, type CreateEmailOptions } from "resend";
import { emailLayout, emailButton, emailParagraph, EMAIL_INK } from "./layout";

let resendClient: Resend | null = null;

function getResend(): Resend {
  if (!resendClient) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error("RESEND_API_KEY not configured");
    resendClient = new Resend(apiKey);
  }
  return resendClient;
}

// The sending domain verified in Resend is updates.altorank.co (eu-west-1).
// The old default, noreply@altorank.com, was a domain this company does not
// own, so every send without RESEND_FROM_EMAIL set was refused.
function fromAddress(): string {
  return process.env.RESEND_FROM_EMAIL ?? "AltoRank <noreply@updates.altorank.co>";
}

/**
 * Every email leaves through here.
 *
 * Resend's SDK does not throw when the API refuses a send. It resolves to
 * `{ data: null, error }`, and with NODE_ENV=production it does not even log.
 * So a wrong key, an unverified domain, a from-address the key may not use,
 * or a rate limit all looked, to every caller in this file, exactly like
 * success. Found on 2026-09-02: password-reset requests showed "on its way"
 * while nothing left and no log line said why. A refusal is now an exception
 * carrying Resend's own code and status, for the caller to log or show.
 */
async function deliver(payload: CreateEmailOptions): Promise<string> {
  const { data, error } = await getResend().emails.send(payload);
  if (error) {
    const status = error.statusCode ? ` ${error.statusCode}` : "";
    throw new Error(`Resend refused the email (${error.name}${status}): ${error.message}`);
  }
  if (!data) throw new Error("Resend returned neither an id nor an error");
  return data.id;
}

export async function sendInviteEmail(
  to: string,
  inviterName: string,
  agencyName: string,
  role: string,
  acceptUrl: string,
): Promise<void> {
  await deliver({
    from: fromAddress(),
    to,
    subject: `You've been invited to join ${agencyName} on AltoRank`,
    html: emailLayout({
      title: `Join ${agencyName} on AltoRank`,
      preheader: `${inviterName} invited you to ${agencyName}`,
      bodyHtml:
        `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:${EMAIL_INK};">Join ${agencyName} on AltoRank</h1>` +
        emailParagraph(`${inviterName} invited you to work on ${agencyName}'s SEO content. Accept to get access to the workspaces, drafts and reports.`) +
        emailButton(acceptUrl, "Accept invitation") +
        emailParagraph(`The link works once and expires in seven days. If you were not expecting this, ignore it and nothing happens.`),
      footerNote: `Sent because ${inviterName} added ${to} to a team on AltoRank.`,
    }),
  });
}

// The monthly report used to render and send itself here, straight through
// `deliver`, which is how it skipped `email_preferences` and the RFC 8058
// headers for a category the preferences page offers a switch for. It lives in
// ./report-email.ts now and goes out through `sendOnce` like the rest.

/**
 * Send free tool results to a lead's email.
 */
export async function sendToolResultEmail(
  to: string,
  subject: string,
  bodyHtml: string,
): Promise<void> {
  await deliver({
    from: fromAddress(),
    to,
    subject,
    html: emailLayout({
      title: subject,
      bodyHtml,
      footerNote: `Sent once, to ${to}, because you asked for it on altorank.co. There is no list to unsubscribe from.`,
    }),
  });
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/**
 * Any transactional email with its own one-line reason in the footer. The
 * auth emails use this; sendToolResultEmail's footer ("because you asked for
 * it on altorank.co") was wrong under a confirm-signup email and showed up
 * twice with the body's own line.
 */
export async function sendTransactionalEmail(
  to: string,
  subject: string,
  bodyHtml: string,
  footerNote: string,
  preheader?: string,
  /**
   * `headers` carries the RFC 8058 List-Unsubscribe pair for the optional
   * categories; `unsubscribeUrl` puts the matching link in the footer. Both
   * are absent for the required ones (lib/email/categories.ts).
   */
  opts?: { headers?: Record<string, string>; unsubscribeUrl?: string | null },
): Promise<void> {
  await deliver({
    from: fromAddress(),
    to,
    subject,
    html: emailLayout({ title: subject, bodyHtml, footerNote, preheader, unsubscribeUrl: opts?.unsubscribeUrl }),
    ...(opts?.headers ? { headers: opts.headers } : {}),
  });
}

/**
 * A plain-text email with attachments: the in-app feedback report, and
 * nothing else so far.
 *
 * It exists so that path stops constructing its own `new Resend()` and
 * checking nothing. Resend's SDK resolves rather than rejects on a refusal, so
 * `await resend.emails.send(...)` inside a try/catch returned 200 "sent" for a
 * refused domain, an invalid key or a rate limit - the exact failure the
 * comment above `deliver` was written about, reintroduced in the one route
 * that did not go through it.
 */
export async function sendPlainEmail(opts: {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  attachments?: { filename: string; content: string }[];
}): Promise<void> {
  await deliver({
    from: fromAddress(),
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
  });
}
