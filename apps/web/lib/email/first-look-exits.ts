// ---------------------------------------------------------------------------
// The setup screen's soft exits, as email: a link back to the first article
// ---------------------------------------------------------------------------
//
// Before the trial the gate was a room with two doors: pay, or sign out (UX
// audit 2026-10-12, #3). "Email me this article" is the third: one email, to
// the owner who asked, with the article's title and a link back to the
// setup page where it is. Never the text: the gate is the only place the
// owner reads it before the trial (lib/onboarding/first-article-body.ts),
// and a real signup copied a draft off a preview page and published it
// within the hour (2026-09-22). An email is a copy that can be forwarded.
//
// Through `sendOnce`, so it is sent at most once per article per address,
// in the optional `drafts` category (an unsubscribe is respected, and the
// mail carries the link to make one), and claimed in `sent_emails` before
// it leaves. On top of that, an address is sent at most
// FIRST_ARTICLE_LINK_DAILY_CAP of these a day whatever the article, so the
// button cannot be used to mail someone over and over.

import type { SupabaseClient } from "@supabase/supabase-js";
import { emailButton, emailLabel, emailNote, emailParagraph, EMAIL_INK } from "./layout";
import { sendOnce, type RenderedEmail, type SendOnceOutcome } from "./send-once";
import { esc, trialGateUrl } from "./article-emails";
import { TRIAL_DAYS } from "@/lib/stripe";
import { fullArticleOn } from "@/lib/onboarding/full-article-switch";

/** The slug in `sent_emails`. */
export const FIRST_ARTICLE_LINK = "first_article_link";
/** At most this many a day to one address, across articles and sites. */
export const FIRST_ARTICLE_LINK_DAILY_CAP = 3;

export type FirstArticleLinkEmail = {
  domain: string | null;
  title: string;
  /**
   * The owner can read the whole text on the setup page before the trial
   * (PRETRIAL_FULL_ARTICLE, on by default). Off, the page shows its outline
   * and the text opens with the trial, and the email must say that instead.
   * Read from the switch when not given.
   */
  readable?: boolean;
};

/** The email: the title and the way back. No word of the article itself. */
export function renderFirstArticleLink(a: FirstArticleLinkEmail): RenderedEmail {
  const site = a.domain ?? "your site";
  const title = a.title.trim() || "Your first article";
  const readable = a.readable ?? fullArticleOn();
  return {
    subject: `Your first article for ${site}`,
    preheader: `The link back to "${title}", as you asked.`,
    footerNote: `Sent once, because you asked for it on the AltoRank setup page.`,
    html:
      emailLabel(site) +
      `<h1 style="margin:0 0 12px;font-size:21px;line-height:1.3;letter-spacing:-0.02em;color:${EMAIL_INK};">${esc(title)}</h1>` +
      emailParagraph(
        readable
          ? `Here is the way back to your first article. It is saved on your setup page, and it is yours to read there whenever you like.`
          : `Here is the way back to your first article. It is saved on your setup page, where you can see its outline; the full text opens when your ${TRIAL_DAYS}-day trial starts.`,
      ) +
      emailButton(trialGateUrl(), "Open my first article") +
      emailParagraph(
        readable
          ? `When you are ready, the ${TRIAL_DAYS}-day trial lets you edit it, approve it and publish it. Nothing publishes until you approve it.`
          : `When you are ready, the ${TRIAL_DAYS}-day trial lets you read it in full, edit it, approve it and publish it. Nothing publishes until you approve it.`,
      ) +
      emailNote(`The article itself is not in this email: it stays on your setup page.`),
  };
}

export type FirstArticleLinkOutcome = SendOnceOutcome & { capped?: boolean };

/**
 * Send the link to `recipient` - the signed-in owner's own address, never one
 * the request named - once for this article, unless they opted out of the
 * category or hit the daily cap. `service` writes the ledger (no client
 * token can).
 */
export async function sendFirstArticleLink(
  service: SupabaseClient,
  recipient: string,
  a: FirstArticleLinkEmail & { articleId: string; accountId: string; workspaceId: string },
  now: Date = new Date(),
): Promise<FirstArticleLinkOutcome> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await service
    .from("sent_emails")
    .select("subject_id", { count: "exact", head: true })
    .eq("email_type", FIRST_ARTICLE_LINK)
    .eq("recipient", recipient.trim().toLowerCase())
    .gte("sent_at", since);
  // A cap we cannot read is not a cap we passed.
  if (error) return { sent: 0, skipped: 0, failed: 1, lastError: `could not read the daily cap: ${error.message}` };
  if ((count ?? 0) >= FIRST_ARTICLE_LINK_DAILY_CAP) return { sent: 0, skipped: 1, failed: 0, capped: true };
  return sendOnce(
    service,
    [recipient],
    { type: FIRST_ARTICLE_LINK, subjectId: a.articleId, category: "drafts", accountId: a.accountId, workspaceId: a.workspaceId },
    () => renderFirstArticleLink(a),
  );
}
