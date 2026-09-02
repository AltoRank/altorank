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

/**
 * Send a monthly report email with a link to the PDF.
 */
export async function sendReportEmail(
  to: string,
  workspaceName: string,
  agencyName: string,
  period: string,
  reportUrl: string,
  highlights: {
    articlesPublished: number;
    keywordsTracked: number;
    topMover?: string;
  },
): Promise<void> {
  const row = (label: string, value: string | number) =>
    `<tr><td style="padding:8px 0;color:#4A4A4A;border-bottom:1px solid #E6E5E2;">${label}</td><td style="padding:8px 0;font-weight:600;text-align:right;border-bottom:1px solid #E6E5E2;">${value}</td></tr>`;
  const rows =
    row("Articles published", highlights.articlesPublished) +
    row("Keywords tracked", highlights.keywordsTracked) +
    (highlights.topMover ? row("Top mover", highlights.topMover) : "");

  await deliver({
    from: fromAddress(),
    to,
    subject: `${workspaceName} — SEO report for ${period}`,
    html: emailLayout({
      title: `${workspaceName}: SEO report for ${period}`,
      preheader: `${highlights.articlesPublished} articles published, ${highlights.keywordsTracked} keywords tracked`,
      bodyHtml:
        `<p style="margin:0 0 4px;font-size:12px;color:#8A8A8A;">${agencyName}</p>` +
        `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:${EMAIL_INK};">${workspaceName}: ${period}</h1>` +
        emailParagraph(`What moved this period. Every number is measured; where nothing was measured the report says so rather than showing a zero.`) +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;font-size:14px;">${rows}</table>` +
        emailButton(reportUrl, "Open the full report") +
        emailParagraph(`The report stays at that link; share it with whoever needs it.`),
      footerNote: `Sent to ${to} as a member of ${agencyName} on AltoRank.`,
    }),
  });
}

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
): Promise<void> {
  await deliver({
    from: fromAddress(),
    to,
    subject,
    html: emailLayout({ title: subject, bodyHtml, footerNote, preheader }),
  });
}
