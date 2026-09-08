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
//
// This is one of two shapes. A single draft - the daily cron's - is this file.
// A batch, which is what a signup produces in the space of a few minutes, is
// lib/email/draft-batch.ts: seven of these for one fan-out is seven copies of
// the same news. Both are built from the same pieces below so the two cannot
// drift into looking like mail from different products.
//
// The layout is the dashboard's, not a mail template's: an uppercase mono
// micro-label over each figure, a bordered panel with a flush body, the same
// hairlines and the same restrained type scale (lib/email/layout.ts). What it
// deliberately does not borrow is anything that needs an image, a webfont, a
// grid or a media query - the value of matching the app is lost the moment the
// mail is the one thing in the inbox that renders wrong.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  emailButton,
  emailCard,
  emailCode,
  emailLabel,
  emailNote,
  emailParagraph,
  emailStatRow,
  EMAIL_INK,
  EMAIL_INK_2,
  EMAIL_INK_3,
  type EmailStat,
  type EmailTone,
} from "./layout";
import { sendOnce, type SendOnceOutcome } from "./send-once";
import { appLink } from "@/lib/app-url";
import type { FactCheckReport } from "@/lib/ai/fact-check";

/** Everything here is a keyword, a title or a domain: all of it user data. */
export const esc = (s: unknown) =>
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
   * The keyword's measured figures, for the stat row.
   *
   * Three states, not two, and the difference is the house rule about never
   * rendering an unknown as a measurement: `undefined` means nobody looked and
   * the cell is left out; `null` means we looked and the provider had nothing,
   * which shows as "—"; a number is a number. A keyword typed in by hand
   * carries null volume all the way through `recommendKeywords`, and a zero
   * there would read as "nobody searches for this".
   */
  volume?: number | null;
  difficulty?: number | null;
  /**
   * Whether the workspace has somewhere to publish to. False adds one line
   * about connecting a site; undefined leaves it out, for callers that did not
   * check.
   */
  cmsConnected?: boolean;
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

/** Where a batch of drafts is read: the review queue, filtered to it. */
export function reviewQueueUrl(): string {
  return appLink("/articles?status=review");
}

/** Where a site is connected to the thing it publishes to. */
export function connectUrl(): string {
  return appLink("/connect");
}

const VERDICT_LINE: Record<FactCheckReport["verdict"], string> = {
  clean: "The fact check found no unsourced figures.",
  review:
    "The fact check flagged some claims worth a look. They are listed against the draft.",
  high_risk:
    "The fact check found at least one figure with no source given anywhere in its sentence. Check those before publishing; they are listed against the draft.",
};

/** The verdict as the dashboard shows a status: a short word and a colour. */
export const VERDICT_PILL: Record<FactCheckReport["verdict"], { label: string; tone: EmailTone }> = {
  clean: { label: "All sourced", tone: "ok" },
  review: { label: "One to confirm", tone: "warn" },
  high_risk: { label: "Unsourced figure", tone: "err" },
};

/** A figure the product measured, or "—" when it did not. Never a stand-in zero. */
export function figure(n: number | null | undefined): string {
  return typeof n === "number" ? n.toLocaleString() : "—";
}

/**
 * The site's name above whatever the mail is about, the way every page in the
 * dashboard carries the workspace above its heading.
 */
export function emailHeader(site: string, headline: string): string {
  return (
    emailLabel(site) +
    `<h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;letter-spacing:-0.02em;color:${EMAIL_INK};">${esc(headline)}</h1>`
  );
}

/**
 * What happens next, in one sentence, and it is the sentence the whole product
 * rests on: a machine chose the topic and wrote the words, and a person still
 * decides whether any of it ships.
 *
 * With auto-approve on that promise has a deadline instead of a gate, and the
 * deadline is only honest if this mail is what starts it - which is why
 * lib/publishing/auto-approve.ts calls the hold window "what makes 'you saw it
 * first' true".
 */
export function approvalLine(autoApproveAfter: string | null | undefined, count: number): string {
  const it = count === 1 ? "it" : "them";
  const waits = count === 1 ? "waits" : "wait";
  const after = autoApproveAfter ? new Date(autoApproveAfter) : null;
  if (after && !Number.isNaN(after.getTime())) {
    const when = after.toLocaleString("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    });
    return `This workspace publishes automatically, so ${count === 1 ? "this one goes" : "these go"} live after <strong>${esc(when)} UTC</strong> unless you hold ${it}. Approving now skips the wait.`;
  }
  return `${count === 1 ? "It" : "They"} ${waits} in your review queue. Nothing publishes until you approve ${count === 1 ? "it" : "them"}.`;
}

/**
 * The one honest line for a site with nowhere to publish to.
 *
 * Not a Connect button dressed up as self-serve: no CMS connector is offered
 * self-serve today (lib/cms/connectable.ts explains why), so this asks rather
 * than promises. Left out entirely when the caller did not check, because a
 * "you have not connected anything" to somebody who has is worse than silence.
 */
export function cmsLine(cmsConnected: boolean | undefined, site: string): string {
  if (cmsConnected !== false) return "";
  return emailNote(
    `Nothing is connected to publish to yet, so approved drafts stay here until something is. ` +
      `Tell us what ${esc(site)} runs on and we will wire it up: ` +
      `<a href="${connectUrl()}" style="color:${EMAIL_INK_3};text-decoration:underline;">${esc(connectUrl())}</a>.`,
  );
}

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
  const verdict = VERDICT_PILL[a.verdict];

  // Word count and the verdict always; the keyword's own figures only when
  // somebody looked them up. Four cells is two tidy rows in the strip.
  const stats: EmailStat[] = [
    { label: "Words", value: a.wordCount.toLocaleString() },
    { label: "Fact check", value: verdict.label, tone: verdict.tone },
  ];
  if (a.volume !== undefined) stats.push({ label: "Searches", value: figure(a.volume), unit: "/mo" });
  if (a.difficulty !== undefined) stats.push({ label: "Difficulty", value: figure(a.difficulty) });

  const holdButton = hold
    ? `<p style="margin:0 0 16px;font-size:13px;color:${EMAIL_INK_3};"><a href="${esc(hold)}" style="color:${EMAIL_INK};text-decoration:underline;">Hold this one</a> - it then waits for someone to approve it.</p>`
    : autoAfter
      ? emailNote("To stop it, open the draft and press Hold.")
      : "";

  const reasons = a.reasons.length
    ? emailCard({
        title: "Why this keyword",
        bodyHtml:
          `<ul style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.7;color:${EMAIL_INK_2};">` +
          a.reasons.slice(0, 4).map((r) => `<li>${esc(r)}</li>`).join("") +
          `</ul>`,
      })
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
      emailLabel(site) +
      `<p style="margin:0 0 14px;font-size:13.5px;line-height:1.6;color:${EMAIL_INK_3};">Written for ${emailCode(a.keyword)}</p>` +
      emailStatRow(stats) +
      `<h1 style="margin:0 0 12px;font-size:21px;line-height:1.3;letter-spacing:-0.02em;color:${EMAIL_INK};">${esc(a.title)}</h1>` +
      emailParagraph(approvalLine(a.autoApproveAfter, 1)) +
      (a.verdict === "clean" ? "" : emailParagraph(VERDICT_LINE[a.verdict])) +
      emailButton(url, "Read the draft") +
      holdButton +
      reasons +
      cmsLine(a.cmsConnected, site) +
      emailNote(
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
 * draft twice - and so lib/email/draft-batch.ts, which claims the same key for
 * every article it digests, cannot announce one that has already gone out on
 * its own. Returns what happened rather than throwing: this is called after
 * the article is already saved, and an email problem must not turn a written
 * draft into a failed run.
 */
export const ARTICLE_DRAFTED = "article_drafted";

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
      type: ARTICLE_DRAFTED,
      subjectId: a.articleId,
      category: "drafts",
      agencyId: scope?.agencyId ?? null,
      workspaceId: scope?.workspaceId ?? null,
    },
    // Rendered per recipient: the hold link is signed to the address.
    (to) => renderArticleDrafted(a, to),
  );
}
