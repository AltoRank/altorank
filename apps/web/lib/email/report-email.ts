// ---------------------------------------------------------------------------
// The monthly report email
// ---------------------------------------------------------------------------
//
// `reports` is an optional category. It is listed on the preferences page under
// "Monthly reports", with a switch, and the switch did nothing: the reports
// cron called the renderer's own sender directly, so the mail carried no
// unsubscribe link, no RFC 8058 headers, and no `sent_emails` claim. An address
// whose preferences said `{reports}` received the August report anyway, and a
// second run of the cron mailed everyone again.
//
// It goes through `sendOnce` now, like every other optional lifecycle email.
// The subject id is the workspace and the period, which is exactly the thing
// the report is about: re-running the cron for August re-sends nothing, and
// September is a different key.

import type { SupabaseClient } from "@supabase/supabase-js";
import { emailButton, emailParagraph, EMAIL_INK } from "./layout";
import { sendOnce, type RenderedEmail, type SendOnceOutcome } from "./send-once";

/** Workspace and account names come from the customer; the period does not. */
const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

export interface MonthlyReportEmail {
  workspaceName: string;
  accountName: string;
  /** "2026-08-01 to 2026-08-31". */
  period: string;
  /** The signed storage URL, good for 30 days (lib/reports/storage.ts). */
  reportUrl: string;
  highlights: {
    articlesPublished: number;
    keywordsTracked: number;
    topMover?: string;
  };
}

export function renderMonthlyReport(r: MonthlyReportEmail, recipient: string): RenderedEmail {
  const row = (label: string, value: string | number) =>
    `<tr><td style="padding:8px 0;color:#4A4A4A;border-bottom:1px solid #E6E5E2;">${label}</td><td style="padding:8px 0;font-weight:600;text-align:right;border-bottom:1px solid #E6E5E2;">${esc(value)}</td></tr>`;
  const rows =
    row("Articles published", r.highlights.articlesPublished) +
    row("Keywords tracked", r.highlights.keywordsTracked) +
    (r.highlights.topMover ? row("Top mover", r.highlights.topMover) : "");

  return {
    subject: `${r.workspaceName} — SEO report for ${r.period}`,
    preheader: `${r.highlights.articlesPublished} articles published, ${r.highlights.keywordsTracked} keywords tracked`,
    footerNote: `Sent to ${recipient} as a member of ${r.accountName} on AltoRank.`,
    html:
      `<p style="margin:0 0 4px;font-size:12px;color:#8A8A8A;">${esc(r.accountName)}</p>` +
      `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:${EMAIL_INK};">${esc(r.workspaceName)}: ${esc(r.period)}</h1>` +
      emailParagraph(
        `What moved this period. Every number is measured; where nothing was measured the report says so rather than showing a zero.`,
      ) +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;font-size:14px;">${rows}</table>` +
      emailButton(r.reportUrl, "Open the full report") +
      emailParagraph(`The link works for 30 days. The report itself stays in your dashboard under Reports.`),
  };
}

/**
 * Mail one workspace's monthly report to the people who should get it, at most
 * once for the period and only to those who have not switched reports off.
 *
 * Never throws, like every `sendOnce` caller: the PDF is already generated and
 * retrievable from the dashboard, so a mail provider being unreachable must not
 * turn a produced report into a failed cron run.
 */
export async function sendMonthlyReportEmails(
  supabase: SupabaseClient,
  recipients: readonly string[],
  r: MonthlyReportEmail,
  scope: { accountId?: string | null; workspaceId?: string | null },
): Promise<SendOnceOutcome> {
  return sendOnce(
    supabase,
    recipients,
    {
      type: "monthly_report",
      subjectId: `${scope.workspaceId ?? r.workspaceName}:${r.period}`,
      category: "reports",
      accountId: scope.accountId ?? null,
      workspaceId: scope.workspaceId ?? null,
    },
    (to) => renderMonthlyReport(r, to),
  );
}
