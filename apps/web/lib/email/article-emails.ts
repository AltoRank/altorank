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

import { sendTransactionalEmail } from "./resend";
import { emailButton, emailParagraph, EMAIL_INK, EMAIL_INK_3 } from "./layout";
import type { FactCheckReport } from "@/lib/ai/fact-check";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3100";

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
}

/**
 * The draft opens at /content/[id]. Not /articles/[id], which does not exist -
 * a link built that way in first-draft-live.tsx was a 404 all the way to
 * review.
 */
export function articleUrl(articleId: string): string {
  return new URL(`/content/${articleId}`, APP_URL).toString();
}

const VERDICT_LINE: Record<FactCheckReport["verdict"], string> = {
  clean: "The fact check found no unsourced figures.",
  review:
    "The fact check flagged some claims worth a look. They are listed against the draft.",
  high_risk:
    "The fact check found at least one figure with no source given anywhere in its sentence. Check those before publishing; they are listed against the draft.",
};

export function renderArticleDrafted(a: ArticleDraftedEmail): {
  subject: string;
  html: string;
  preheader: string;
  footerNote: string;
} {
  const site = a.domain ?? "your site";
  const url = articleUrl(a.articleId);
  const warn = a.verdict === "high_risk";

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
    preheader: `${a.wordCount.toLocaleString()} words, waiting in your review queue.`,
    footerNote: `Sent because automatic drafting is on for ${esc(site)}. Turn it off in that site's settings and these stop.`,
    html:
      `<p style="margin:0 0 4px;font-size:12px;color:${EMAIL_INK_3};">${esc(site)}</p>` +
      `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${EMAIL_INK};">${esc(a.title)}</h1>` +
      emailParagraph(
        `Written for <strong>${esc(a.keyword)}</strong>. ${a.wordCount.toLocaleString()} words. ` +
          `It is a draft in your review queue - nothing publishes until you approve it.`,
      ) +
      emailParagraph(VERDICT_LINE[a.verdict]) +
      reasons +
      emailButton(url, "Read the draft") +
      emailParagraph(
        `If this is not what the site should be writing about, the keyword came from its queue - changing what is tracked changes what gets written next.`,
      ),
  };
}

/**
 * Tell every member of the agency. One send each, and a failure for one address
 * does not stop the others.
 *
 * Returns what happened rather than throwing: this is called after the article
 * is already saved, and an email problem must not turn a written draft into a
 * failed run.
 */
export async function sendArticleDraftedEmails(
  recipients: readonly string[],
  a: ArticleDraftedEmail,
): Promise<{ sent: number; failed: number; lastError?: string }> {
  if (!recipients.length) return { sent: 0, failed: 0 };
  const { subject, html, preheader, footerNote } = renderArticleDrafted(a);

  let sent = 0;
  let failed = 0;
  let lastError: string | undefined;

  for (const to of recipients) {
    try {
      await sendTransactionalEmail(to, subject, html, footerNote, preheader);
      sent += 1;
    } catch (err) {
      failed += 1;
      lastError = err instanceof Error ? err.message : "unknown error";
    }
  }

  return { sent, failed, ...(lastError ? { lastError } : {}) };
}
