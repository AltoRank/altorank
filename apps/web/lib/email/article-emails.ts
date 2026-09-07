// ---------------------------------------------------------------------------
// Telling somebody a draft was written
// ---------------------------------------------------------------------------
//
// The unattended generator writes into a review queue and, until now, said
// nothing. Four runs a day (296ad6a) and a pace of one a day per site (042)
// means a customer who does not open the dashboard has drafts piling up in
// review, unread, while the product looks idle. The article is not the
// deliverable; the article *and somebody knowing about it* is.
//
// Only the unattended path sends. When a person presses Generate they are
// watching the editor stream it, and an email about a thing on their screen is
// noise, not news.
//
// The fact-check verdict is in the subject line on purpose. `high_risk` means
// at least one figure in the draft has no attribution anywhere in its sentence
// (lib/ai/fact-check.ts), and that is the one case where the reader's job is
// different: not "read this when you have a minute" but "do not publish this
// until you have checked a number". Burying it in the body would make the
// email a notification instead of a warning.

import type { SupabaseClient } from "@supabase/supabase-js";
import { emailButton, emailParagraph, EMAIL_INK, EMAIL_INK_3 } from "./layout";
import { sendOnce, type SendOnceOutcome } from "./send-once";
import { appLink } from "@/lib/app-url";
import type { FactCheckReport } from "@/lib/ai/fact-check";



/** Everything here is a keyword, a title or a domain: all of it user data. */
const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

export interface ArticleDraftedEmail {
  domain: string | null;
  keyword: string;
  title: string;
  wordCount: number;
  verdict: FactCheckReport["verdict"];
  /** Why this keyword, captured when it was chosen (migration 022). */
  reasons: readonly string[];
  articleId: string;
  /**
   * When the workspace publishes automatically: the end of the hold window,
   * after which the draft ships on the next publish run unless held. Null or
   * absent when every draft waits for a click (migration 079).
   */
  autoApproveAfter?: string | null;
  /**
   * The signed one-click hold URL for one recipient (lib/publishing/hold-link.ts),
   * or null when no secret is configured. Per recipient, because the hold is
   * recorded against the person whose address was in the link.
   */
  holdUrlFor?: (recipient: string) => string | null;
}

/**
 * The draft opens at /content/[id]. Not /articles/[id], which does not exist -
 * a link built that way in first-draft-live.tsx was a 404 all the way to
 * review.
 */
export function articleUrl(articleId: string): string {
  return appLink(`/content/${articleId}`);
}

const VERDICT_LINE: Record<FactCheckReport["verdict"], string> = {
  clean: "The fact check found no unsourced figures.",
  review:
    "The fact check flagged some claims worth a look. They are listed against the draft.",
  high_risk:
    "The fact check found at least one figure with no source given anywhere in its sentence. Check those before publishing; they are listed against the draft.",
};

export function renderArticleDrafted(a: ArticleDraftedEmail, recipient?: string): {
  subject: string;
  html: string;
  preheader: string;
  footerNote: string;
} {
  const site = a.domain ?? "your site";
  const url = articleUrl(a.articleId);
  const warn = a.verdict === "high_risk";
  const autoAfter = a.autoApproveAfter ? new Date(a.autoApproveAfter) : null;
  const hold = autoAfter && recipient && a.holdUrlFor ? a.holdUrlFor(recipient) : null;
  const autoLine = autoAfter && !Number.isNaN(autoAfter.getTime())
    ? `It publishes on its own after ${autoAfter.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC unless you hold it${hold ? "" : " - open the draft and press Hold"}, or approve it now to skip the wait.`
    : `It is a draft in your review queue - nothing publishes until you approve it.`;
  const holdButton = hold
    ? `<p style="margin:0 0 16px;font-size:13px;"><a href="${hold}" style="color:${EMAIL_INK};text-decoration:underline;">Hold this one</a> - it then waits for someone to approve it.</p>`
    : "";

  const reasons = a.reasons.length
    ? `<p style="margin:0 0 6px;font-size:12px;color:${EMAIL_INK_3};">Why this keyword</p>` +
      `<ul style="margin:0 0 16px;padding-left:18px;font-size:14px;line-height:1.6;color:${EMAIL_INK};">` +
      a.reasons.slice(0, 4).map((r) => `<li>${esc(r)}</li>`).join("") +
      `</ul>`
    : "";

  return {
    subject: warn
      ? `Check before publishing: "${a.keyword}" draft for ${site}`
      : `New draft for ${site}: "${a.keyword}"`,
    preheader: autoAfter
      ? `${a.wordCount.toLocaleString()} words, publishes on its own unless you hold it.`
      : `${a.wordCount.toLocaleString()} words, waiting in your review queue.`,
    footerNote: `Sent because automatic drafting is on for ${esc(site)}.`,
    html:
      `<p style="margin:0 0 4px;font-size:12px;color:${EMAIL_INK_3};">${esc(site)}</p>` +
      `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${EMAIL_INK};">${esc(a.title)}</h1>` +
      emailParagraph(
        `Written for <strong>${esc(a.keyword)}</strong>. ${a.wordCount.toLocaleString()} words. ` +
          autoLine,
      ) +
      emailParagraph(VERDICT_LINE[a.verdict]) +
      reasons +
      emailButton(url, "Read the draft") +
      holdButton +
      emailParagraph(
        `If this is not what the site should be writing about, the keyword came from its queue - changing what is tracked changes what gets written next.`,
      ),
  };
}

/**
 * Tell every member of the agency, at most once each, and only those who still
 * want to be told.
 *
 * This is the highest-volume email the product sends, and until now it was the
 * only lifecycle email that went out around `sendOnce` rather than through it:
 * no `sent_emails` claim, no `email_preferences` check, no unsubscribe link and
 * no RFC 8058 headers. Both halves of that were reproduced on the merged tree -
 * called twice for one article id it sent six messages, and an address that had
 * unsubscribed from `drafts` received the next draft anyway. The held digest,
 * which is the same `drafts` category about the same drafts, had all four.
 *
 * Ignoring an unsubscribe is not untidiness. It is the one email behaviour with
 * legal exposure (GDPR, CAN-SPAM), on the email sent most often.
 *
 * Keyed on the article id, so the four generate runs a day cannot announce one
 * draft twice. Returns what happened rather than throwing: this is called after
 * the article is already saved, and an email problem must not turn a written
 * draft into a failed run.
 */
export async function sendArticleDraftedEmails(
  supabase: SupabaseClient,
  recipients: readonly string[],
  a: ArticleDraftedEmail,
  scope?: { agencyId?: string | null; workspaceId?: string | null },
): Promise<SendOnceOutcome> {
  return sendOnce(
    supabase,
    recipients,
    {
      type: "article_drafted",
      subjectId: a.articleId,
      category: "drafts",
      agencyId: scope?.agencyId ?? null,
      workspaceId: scope?.workspaceId ?? null,
    },
    // Rendered per recipient: the hold link is signed to the address.
    (to) => renderArticleDrafted(a, to),
  );
}
