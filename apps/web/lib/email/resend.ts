import { Resend } from "resend";

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
export async function sendInviteEmail(
  to: string,
  inviterName: string,
  agencyName: string,
  role: string,
  acceptUrl: string,
): Promise<void> {
  const resend = getResend();
  const from = process.env.RESEND_FROM_EMAIL ?? "AltoRank <noreply@updates.altorank.co>";

  await resend.emails.send({
    from,
    to,
    subject: `You've been invited to join ${agencyName} on AltoRank`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #1a1a1a; margin-bottom: 8px;">Join ${agencyName} on AltoRank</h2>
        <p style="color: #666; line-height: 1.6;">
          ${inviterName} has invited you to join <strong>${agencyName}</strong> as ${article(role)} <strong>${role}</strong>.
        </p>
        <a href="${acceptUrl}" style="display: inline-block; margin: 24px 0; padding: 12px 24px; background-color: #2563eb; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600;">
          Accept Invitation
        </a>
        <p style="color: #999; font-size: 13px; line-height: 1.5;">
          This invitation expires in 7 days. If you didn't expect this email, you can safely ignore it.
        </p>
      </div>
    `,
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
  const resend = getResend();
  const from = process.env.RESEND_FROM_EMAIL ?? "AltoRank <noreply@updates.altorank.co>";

  const highlightRows = [
    `<tr><td style="padding:6px 0;color:#666;">Articles published</td><td style="padding:6px 0;font-weight:600;text-align:right;">${highlights.articlesPublished}</td></tr>`,
    `<tr><td style="padding:6px 0;color:#666;">Keywords tracked</td><td style="padding:6px 0;font-weight:600;text-align:right;">${highlights.keywordsTracked}</td></tr>`,
    highlights.topMover
      ? `<tr><td style="padding:6px 0;color:#666;">Top mover</td><td style="padding:6px 0;font-weight:600;text-align:right;">${highlights.topMover}</td></tr>`
      : "",
  ].join("");

  await resend.emails.send({
    from,
    to,
    subject: `${workspaceName} — SEO Report for ${period}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px;">
        <p style="color: #999; font-size: 12px; margin-bottom: 4px;">${agencyName}</p>
        <h2 style="color: #1a1a1a; margin-bottom: 8px;">Monthly SEO Report</h2>
        <p style="color: #666; line-height: 1.6;">
          Here's the performance summary for <strong>${workspaceName}</strong> covering <strong>${period}</strong>.
        </p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px;">
          ${highlightRows}
        </table>
        <a href="${reportUrl}" style="display: inline-block; margin: 16px 0; padding: 12px 24px; background-color: #2563eb; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600;">
          View Full Report (PDF)
        </a>
        <p style="color: #999; font-size: 13px; line-height: 1.5; margin-top: 24px;">
          This report was generated automatically by AltoRank. Questions? Reply to this email.
        </p>
      </div>
    `,
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
  const resend = getResend();
  const from = process.env.RESEND_FROM_EMAIL ?? "AltoRank <noreply@updates.altorank.co>";

  await resend.emails.send({
    from,
    to,
    subject,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px;">
        ${bodyHtml}
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;" />
        <p style="color: #999; font-size: 12px; line-height: 1.5;">
          Sent by <a href="https://altorank.co" style="color: #2563eb;">AltoRank</a> — free SEO tools for agencies.
        </p>
      </div>
    `,
  });
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}
