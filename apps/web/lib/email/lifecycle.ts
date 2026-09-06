// ---------------------------------------------------------------------------
// The lifecycle emails: what the product tells you when it does something
// ---------------------------------------------------------------------------
//
// Before this file the app sent eight emails and skipped twelve. What it
// skipped was, almost exactly, everything that happens *after* somebody starts
// paying: an article going live, a publish failing, a card being declined, a
// plan ending, a pause running out, a key being created. The product did the
// work and said nothing, so the only way to learn that a client's post had
// failed to publish was to open the dashboard and notice.
//
// Three rules hold for every send here, and they are enforced by `sendOnce`
// rather than by remembering:
//
//   once      claimed in `sent_emails` (migration 072) before it leaves, keyed
//             by (type, subject, recipient). A retried Stripe webhook, a cron
//             that runs four times a day and a double-submitted form all
//             produce one email.
//   scoped    work on a site goes to `agencyRecipients(supabase, agency,
//             workspace)`, which honours `agency_members.workspace_ids`; money
//             and account facts go to `agencyBillingRecipients`, which is
//             owner/admin. An editor scoped to one client never learns about
//             another, and never learns what the account pays.
//   quiet on  every function returns an outcome instead of throwing. All of
//   failure   these announce work that is already done and recorded; a mail
//             provider being down must not turn a published article into a
//             failed cron run.
//
// The copy is the same voice as the rest: say what happened, say what it means
// for them, link to the one place they can act, and never claim a result we
// have not measured.

import type { SupabaseClient } from "@supabase/supabase-js";
import { agencyRecipients, agencyBillingRecipients, userEmail } from "./agency-recipients";
import { appLink } from "./app-url";
import { emailButton, emailParagraph, EMAIL_INK, EMAIL_INK_2, EMAIL_INK_3 } from "./layout";
import { sendOnce, type RenderedEmail, type SendOnceOutcome } from "./send-once";

/** Every string below is user data: a domain, a title, a keyword, a name. */
const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

function heading(text: string): string {
  return `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${EMAIL_INK};">${esc(text)}</h1>`;
}

function eyebrow(text: string): string {
  return `<p style="margin:0 0 4px;font-size:12px;color:${EMAIL_INK_3};">${esc(text)}</p>`;
}

/** A quoted error or URL, wrapped so a long one does not blow the column out. */
function quoted(text: string): string {
  return `<p style="margin:0 0 14px;padding:10px 12px;background:#FAF9F7;border-radius:7px;font-size:13px;line-height:1.55;color:${EMAIL_INK_2};word-break:break-word;">${esc(text)}</p>`;
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------------
// Article lifecycle
// ---------------------------------------------------------------------------

export type DraftApprovedEmail = {
  domain: string | null;
  title: string;
  keyword: string | null;
  articleId: string;
  /** Who pressed Approve, as they are known to the account. */
  approvedBy: string;
  /** When the cadence will pick it up, when the workspace has one. */
  scheduledFor: string | null;
};

/**
 * Approval is the one moment a second person needs to know about: it is the
 * gate that separates this from a content farm, and after it the article ships
 * without anybody else being asked. A colleague who edited the draft should
 * learn that it was signed off, not discover it live on the client's site.
 */
export function renderDraftApproved(a: DraftApprovedEmail): RenderedEmail {
  const site = a.domain ?? "your site";
  const when = a.scheduledFor
    ? `It is queued to publish on ${dateLabel(a.scheduledFor)}.`
    : `It joins the publishing queue and goes out on this site's next scheduled slot.`;
  return {
    subject: `Approved for ${site}: "${a.title}"`,
    preheader: `${a.approvedBy} approved it. ${a.scheduledFor ? "Queued to publish." : "Waiting for the next slot."}`,
    footerNote: `Sent because you have access to ${site} on AltoRank.`,
    html:
      eyebrow(site) +
      heading(a.title) +
      emailParagraph(`<strong>${esc(a.approvedBy)}</strong> approved this draft. ${esc(when)}`) +
      (a.keyword ? emailParagraph(`It was written for <strong>${esc(a.keyword)}</strong>.`) : "") +
      emailButton(appLink(`/content/${a.articleId}`), "Read what was approved") +
      emailParagraph(
        `Nothing is on the site yet. Sending it back for changes on that page clears the sign-off, and it will not publish until somebody approves it again.`,
      ),
  };
}

export type ArticlePublishedEmail = {
  domain: string | null;
  title: string;
  articleId: string;
  /** The address the CMS or the verified build reported. Never a guess. */
  url: string | null;
};

/**
 * The one email a customer would actually forward to their client. It carries
 * the live URL, and only a URL something confirmed: a git publish sends this
 * after the build is verified, not when the commit lands, because a link that
 * 404s is worse than no link (see cron/publish Phase 3).
 */
export function renderArticlePublished(a: ArticlePublishedEmail): RenderedEmail {
  const site = a.domain ?? "your site";
  return {
    subject: `Published on ${site}: "${a.title}"`,
    preheader: a.url ? `It is live at ${a.url}` : "It is live.",
    footerNote: `Sent because you have access to ${site} on AltoRank.`,
    html:
      eyebrow(site) +
      heading(a.title) +
      emailParagraph(`This is live on the site now.`) +
      (a.url
        ? emailButton(a.url, "Open the live article") +
          quoted(a.url)
        : emailParagraph(
            `The CMS did not report a public address for it, so there is no link to give here. It is published on their side.`,
          )) +
      emailParagraph(
        `<a href="${esc(appLink(`/content/${a.articleId}`))}" style="color:${EMAIL_INK_2};">The draft and its history</a> stay in AltoRank. Ranking data for it appears once Search Console has something to report, which is usually days rather than hours.`,
      ),
  };
}

export type PublishFailedEmail = {
  domain: string | null;
  title: string;
  articleId: string;
  /** The adapter's or the database's own message. Not a paraphrase. */
  reason: string;
  /** Which CMS it was going to, when a destination was resolved. */
  destination: string | null;
  /** True for the git case where the commit landed but the URL never resolved. */
  committed?: boolean;
};

/**
 * A failed publish is the one thing in this product that a customer must be
 * told about rather than shown, because the failure is silent everywhere else:
 * the article goes back to review and the calendar simply has a gap.
 *
 * The reason is quoted verbatim. A paraphrase would send somebody looking at
 * the wrong thing, and these messages come from the CMS - "401 Unauthorized",
 * "category does not exist" - and say exactly what to fix.
 */
export function renderPublishFailed(a: PublishFailedEmail): RenderedEmail {
  const site = a.domain ?? "your site";
  const where = a.destination ? ` to ${a.destination}` : "";
  return {
    subject: `Could not publish to ${site}: "${a.title}"`,
    preheader: `It is back in review. ${a.reason.slice(0, 90)}`,
    footerNote: `Sent because you have access to ${site} on AltoRank.`,
    html:
      eyebrow(site) +
      heading(`Publishing failed`) +
      emailParagraph(
        a.committed
          ? `<strong>${esc(a.title)}</strong> was committed to the repository, but the published address never resolved, so we cannot say where it is.`
          : `<strong>${esc(a.title)}</strong> could not be published${esc(where)}. The article is back in review; nothing partial was left on the site.`,
      ) +
      emailParagraph(`What the ${a.destination ? esc(a.destination) : "connection"} said:`) +
      quoted(a.reason) +
      emailButton(appLink(`/content/${a.articleId}`), "Open the article and retry") +
      emailParagraph(
        a.committed
          ? `The content is in the repository either way. Check that the site built, and that the blog URL on the connection matches where posts actually appear, then publish again.`
          : `Retry is on that page and goes back through the same connection. If the message is about credentials, <a href="${esc(appLink("/connect"))}" style="color:${EMAIL_INK_2};">the connection settings</a> are where to fix it. Nothing else in the queue is blocked by this.`,
      ),
  };
}

export type RefreshReadyEmail = {
  domain: string | null;
  pageTitle: string;
  pageUrl: string | null;
  executionId: string;
  /** Blocks the model changed, out of the blocks it looked at. */
  changed: number;
  hunks: number;
  /** Checks the fact-checker flagged on the proposed text. */
  issues: number;
};

/**
 * A refresh proposal is a diff waiting for a person. Nothing reaches the CMS
 * until somebody accepts hunks and presses push, which is why this says
 * "proposed" everywhere and never "updated".
 */
export function renderRefreshReady(a: RefreshReadyEmail): RenderedEmail {
  const site = a.domain ?? "your site";
  const issues =
    a.issues > 0
      ? `${a.issues} ${a.issues === 1 ? "claim was" : "claims were"} flagged by the fact check and are marked in the diff.`
      : `The fact check flagged nothing in the proposed text.`;
  return {
    subject: `Improvement proposed for ${site}: "${a.pageTitle}"`,
    preheader: `${a.changed} of ${a.hunks} blocks rewritten, waiting for review.`,
    footerNote: `Sent because scheduled improvements are on for ${site}. Turn them off in that site's settings and these stop.`,
    html:
      eyebrow(site) +
      heading(a.pageTitle) +
      emailParagraph(
        `An existing page was reviewed against what Search Console shows it ranking for, and a rewrite is proposed: ` +
          `<strong>${a.changed} of ${a.hunks}</strong> ${a.hunks === 1 ? "block" : "blocks"} changed. ${esc(issues)}`,
      ) +
      emailParagraph(
        `Nothing has been sent to the site. The diff is block by block - accept the ones you want and leave the rest.`,
      ) +
      emailButton(appLink(`/improvements/${a.executionId}`), "Review the proposed changes") +
      (a.pageUrl
        ? emailParagraph(
            `The page as it stands today: <a href="${esc(a.pageUrl)}" style="color:${EMAIL_INK_2};">${esc(a.pageUrl)}</a>`,
          )
        : ""),
  };
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export type PaymentFailedEmail = {
  agencyName: string | null;
  planLabel: string;
  /** End of the 7-day window from lib/billing/dunning.ts. Same date the banner shows. */
  graceEndsAt: string;
  /** Formatted amount, when Stripe gave one. Never invented. */
  amount: string | null;
};

/**
 * Dunning, once per failed renewal - not once per Stripe retry.
 *
 * Says the same thing the in-app banner says, from the same `payment_failed_at`
 * and the same GRACE_DAYS, because a customer who reads "your plan is on until
 * December 8" in the app and "your account is suspended" in their inbox has
 * been told two things by one company.
 *
 * No threat and no urgency device. The facts are plain enough: the card was
 * declined, the plan keeps working for a week, and here is the one button that
 * fixes it.
 */
export function renderPaymentFailed(a: PaymentFailedEmail): RenderedEmail {
  const who = a.agencyName ? `${a.agencyName}'s ` : "your ";
  return {
    subject: `Your card was declined — ${a.planLabel} stays on until ${dateLabel(a.graceEndsAt)}`,
    preheader: `Update the card and nothing changes. Writing and publishing continue meanwhile.`,
    footerNote: `Sent because you manage billing for this AltoRank account.`,
    html:
      heading("The renewal payment did not go through") +
      emailParagraph(
        `The card on file was declined${a.amount ? ` for ${esc(a.amount)}` : ""}, so ${esc(who)}${esc(a.planLabel)} plan did not renew.`,
      ) +
      emailParagraph(
        `<strong>Nothing has stopped.</strong> Drafting, approving and publishing all keep working until ` +
          `<strong>${esc(dateLabel(a.graceEndsAt))}</strong>. Your bank may retry on its own in that time; if it goes through, this resolves itself and you can ignore this email.`,
      ) +
      emailButton(appLink("/settings/billing"), "Update the card") +
      emailParagraph(
        `If it is still unpaid after that date the account goes back to the free tier: the workspaces, articles, keywords and history all stay, and approving and publishing stop until the card is updated. Nothing is deleted at any point.`,
      ),
  };
}

export type SubscriptionCancelledEmail = {
  agencyName: string | null;
  planLabel: string;
  /** When the plan actually stops, from Stripe. Null when Stripe gave no date. */
  endsAt: string | null;
};

/**
 * The cancellation confirmation, sent from the webhook so it covers both doors:
 * our own Cancel dialog and the Stripe portal, which the Billing page links
 * straight into.
 *
 * No win-back offer. The retention screen already asked once, and asking again
 * in the confirmation of a decision is the behaviour the one-star reviews in
 * this category are about.
 */
export function renderSubscriptionCancelled(a: SubscriptionCancelledEmail): RenderedEmail {
  const until = a.endsAt
    ? `You keep the ${a.planLabel} plan until ${dateLabel(a.endsAt)}.`
    : `You keep the ${a.planLabel} plan until the end of the period you have paid for.`;
  return {
    subject: a.endsAt ? `Your plan ends on ${dateLabel(a.endsAt)}` : "Your plan is set to end",
    preheader: "Nothing is deleted. Your articles and history stay readable.",
    footerNote: `Sent because you manage billing for this AltoRank account.`,
    html:
      heading("Your plan is set to end") +
      emailParagraph(`${esc(until)} It will not renew after that.`) +
      emailParagraph(
        `Until then everything works as it does now. Afterwards the account goes to the free tier: every workspace, article, keyword and report stays and stays readable and exportable, and drafting and publishing stop.`,
      ) +
      emailButton(appLink("/settings/billing"), "Keep the plan instead") +
      emailParagraph(
        `That button undoes the cancellation and the plan renews as before. If you meant to do this, there is nothing else to do - you will not hear from us about it again.`,
      ),
  };
}

export type AccountPausedEmail = {
  agencyName: string | null;
  /** YYYY-MM-DD, the same value written to workspaces.paused_until. */
  pausedUntil: string;
  siteCount: number;
};

export function renderAccountPaused(a: AccountPausedEmail): RenderedEmail {
  const until = dateLabel(`${a.pausedUntil}T00:00:00Z`);
  return {
    subject: `Paused until ${until}`,
    preheader: "Billing and writing stop. Everything you have is kept.",
    footerNote: `Sent because you manage billing for this AltoRank account.`,
    html:
      heading(`Your account is paused until ${until}`) +
      emailParagraph(
        `${a.siteCount === 1 ? "Your site" : `All ${a.siteCount} of your sites`} stopped drafting and publishing, and Stripe will not collect again until that date.`,
      ) +
      emailParagraph(
        `Your articles, keywords, connections and settings are all kept exactly as they are. Nothing is written and nothing is charged while the pause runs.`,
      ) +
      emailButton(appLink("/settings/billing"), "End the pause early") +
      emailParagraph(
        `On ${esc(until)} the sites go back to drafting on their own schedule and billing resumes. We will send one reminder a few days before that happens.`,
      ),
  };
}

export type PauseEndingEmail = {
  agencyName: string | null;
  pausedUntil: string;
  daysLeft: number;
};

/**
 * The reminder that matters most: a pause ends by itself, both here and at
 * Stripe, so the first sign of it for a customer who forgot would be a charge.
 * Sent a few days early so ending it or extending it is still a choice.
 */
export function renderPauseEnding(a: PauseEndingEmail): RenderedEmail {
  const until = dateLabel(`${a.pausedUntil}T00:00:00Z`);
  const days = a.daysLeft === 1 ? "tomorrow" : `in ${a.daysLeft} days`;
  return {
    subject: `Your pause ends ${days}`,
    preheader: `Writing and billing resume on ${until}.`,
    footerNote: `Sent because you manage billing for this AltoRank account.`,
    html:
      heading(`Your pause ends on ${until}`) +
      emailParagraph(
        `On that date your sites start drafting again on their own schedule, and Stripe collects the next invoice. That is ${esc(days)}.`,
      ) +
      emailParagraph(
        `If that is what you want, there is nothing to do. If it is not, the billing page is where to pause for longer or end the plan - either one is better done before the date than after it.`,
      ) +
      emailButton(appLink("/settings/billing"), "Open billing"),
  };
}

export type PlanChangedEmail = {
  fromLabel: string;
  toLabel: string;
  /** Included articles a month on the new tier; null for a plan with no ceiling. */
  articleLimit: number | null;
  upgrade: boolean;
};

export function renderPlanChanged(a: PlanChangedEmail): RenderedEmail {
  const allowance =
    a.articleLimit === null
      ? `There is no metered article ceiling on ${a.toLabel}.`
      : `That is ${a.articleLimit} articles a month.`;
  return {
    subject: `Your plan is now ${a.toLabel}`,
    preheader: `Changed from ${a.fromLabel}. ${allowance}`,
    footerNote: `Sent because you manage billing for this AltoRank account.`,
    html:
      heading(`You are on ${a.toLabel}`) +
      emailParagraph(
        `The plan changed from <strong>${esc(a.fromLabel)}</strong> to <strong>${esc(a.toLabel)}</strong>. ${esc(allowance)}`,
      ) +
      emailParagraph(
        a.upgrade
          ? `Stripe has charged the difference for the rest of this billing period, prorated, and the new allowance applies from now.`
          : `Stripe has credited the unused part of the old price against the next invoice. The new allowance applies from now, so a site already writing above the new pace will slow to it.`,
      ) +
      emailButton(appLink("/settings/billing"), "See what is included") +
      emailParagraph(`The invoice for this change is in the Stripe billing portal, linked from that page.`),
  };
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export type WelcomeEmail = {
  name: string | null;
  domain: string | null;
};

/**
 * After the address is confirmed, not at signup: the confirmation email is
 * already in their inbox and a second one before they have clicked it is two
 * emails saying "click the other one".
 *
 * Says what the product will do next without promising a result. Every claim
 * here is about our own behaviour - one free draft, approval required, nothing
 * charged - and none about rankings.
 */
export function renderWelcome(a: WelcomeEmail): RenderedEmail {
  const site = a.domain;
  return {
    subject: "Your AltoRank account is live",
    preheader: "What happens next, and the one thing that needs you.",
    footerNote: `Sent once, because you confirmed your email address on AltoRank.`,
    html:
      heading(a.name ? `You are in, ${a.name}` : "You are in") +
      emailParagraph(
        site
          ? `${esc(site)} is set up. AltoRank reads the site, works out what it could realistically rank for, and writes a first draft for the best of those.`
          : `Your account is set up. Add a site and AltoRank reads it, works out what it could realistically rank for, and writes a first draft for the best of those.`,
      ) +
      emailParagraph(
        `<strong>Nothing publishes without you.</strong> Every article lands in a review queue and stays there until somebody approves it. That is the whole point of the product and there is no setting that turns it off.`,
      ) +
      emailButton(appLink("/dashboard"), "Open the dashboard") +
      emailParagraph(
        `The first draft is free and nothing is charged until you choose a plan - there is no trial running out and no card on file. When a draft is written for you we will email you about it; you can turn those off from any of them.`,
      ),
  };
}

export type PasswordChangedEmail = {
  email: string;
  /** ISO timestamp of the change. */
  at: string;
};

/**
 * A security notice, and the only email here that is worth sending even when
 * the person already knows: the case it exists for is the one where they do
 * not, and a stolen account is silent otherwise.
 */
export function renderPasswordChanged(a: PasswordChangedEmail): RenderedEmail {
  return {
    subject: "Your AltoRank password was changed",
    preheader: "If that was not you, reset it now.",
    footerNote: `Sent to ${a.email} because the password on this AltoRank account was changed.`,
    html:
      heading("Your password was changed") +
      emailParagraph(
        `The password for <strong>${esc(a.email)}</strong> was changed on ${esc(dateLabel(a.at))}. If that was you, there is nothing to do.`,
      ) +
      emailParagraph(
        `If it was not you, somebody else has access to this account right now. Reset the password immediately - that signs every other session out.`,
      ) +
      emailButton(appLink("/reset-password"), "Reset the password") +
      emailParagraph(
        `We will never ask you for your password by email, and no link we send asks you to type it anywhere but on altorank.co.`,
      ),
  };
}

export type ApiKeyCreatedEmail = {
  keyName: string;
  prefix: string;
  createdBy: string;
  canWrite: boolean;
  expiresAt: string | null;
};

/**
 * An API key is a credential that can act on the account without signing in,
 * and a write-scoped one can change plans and edit drafts. The person who
 * created it knows; the other owners and admins are exactly who should be told
 * if they did not.
 *
 * The key value is never in here. It leaves the server once, on the screen
 * that created it.
 */
export function renderApiKeyCreated(a: ApiKeyCreatedEmail): RenderedEmail {
  const scope = a.canWrite
    ? `It can read <em>and change</em> things: drafts, keywords, the plan.`
    : `It can read only. It cannot change drafts, keywords or the plan.`;
  const expiry = a.expiresAt ? `It expires on ${dateLabel(a.expiresAt)}.` : `It does not expire.`;
  return {
    subject: `A new API key was created: ${a.keyName}`,
    preheader: `${a.prefix}… created by ${a.createdBy}.`,
    footerNote: `Sent because you are an owner or admin of this AltoRank account.`,
    html:
      heading("A new API key was created") +
      emailParagraph(
        `<strong>${esc(a.createdBy)}</strong> created an API key called <strong>${esc(a.keyName)}</strong>, starting <code>${esc(a.prefix)}</code>. ${scope} ${esc(expiry)}`,
      ) +
      emailParagraph(
        `A key works without a password and without a browser. If you do not recognise this one, revoke it - that takes effect at once and nothing else on the account is affected.`,
      ) +
      emailButton(appLink("/settings/api-keys"), "See the account's keys") +
      emailParagraph(`The key's value is not in this email. It is shown once, to whoever created it, and never stored.`),
  };
}

// ---------------------------------------------------------------------------
// Product state: nothing is being written, and why
// ---------------------------------------------------------------------------

export type NothingWrittenReason = "no-keywords" | "queue-exhausted" | "paused" | "pace-zero";

export type NothingWrittenEmail = {
  domain: string | null;
  reason: NothingWrittenReason;
  /** For "paused", the date it lifts, when the pause carries one. */
  pausedUntil?: string | null;
};

const NOTHING_WRITTEN: Record<
  NothingWrittenReason,
  { subject: (site: string) => string; what: string; fix: string; cta: (path: string) => string; path: string }
> = {
  "no-keywords": {
    subject: (site) => `Nothing is being written for ${site}`,
    what: "There are no keywords tracked for this site, so the scheduler has nothing to choose from.",
    fix: "Add a few keywords, or run the keyword research and accept what it suggests. The next scheduled run picks up from there.",
    cta: () => "Add keywords",
    path: "/keywords",
  },
  "queue-exhausted": {
    subject: (site) => `${site} has run out of keywords to write about`,
    what:
      "Every keyword in the queue is now covered, already ranking, or was filtered out as provider noise, so the scheduler passed over this site.",
    fix: "Adding keywords starts it again. The research page proposes new ones from what the site already ranks for.",
    cta: () => "Find more keywords",
    path: "/keywords",
  },
  paused: {
    subject: (site) => `${site} is paused, so nothing is being written`,
    what: "This site is paused. Drafting and publishing are both stopped.",
    fix: "Resuming it from the site switcher puts it back into the next scheduled run.",
    cta: () => "Open the calendar",
    path: "/content",
  },
  "pace-zero": {
    subject: (site) => `${site} is set to write nothing`,
    what: "This site's weekly pace is set to zero, which means the scheduler is meant to skip it.",
    fix: "Raise the pace from the calendar's plan control and it starts writing on the next run.",
    cta: () => "Set the pace",
    path: "/content",
  },
};

/**
 * The email for a site the product has quietly stopped working on.
 *
 * This is the failure mode an unattended writer has that a person does not: it
 * skips, records "skipped" in a cron's JSON body, and the customer sees a
 * calendar that simply stops. Every reason here is one the customer can fix in
 * about a minute, which is why it is worth an email at all - and why it is sent
 * at most once a week per site (`sendOnce`, keyed by ISO week).
 */
export function renderNothingWritten(a: NothingWrittenEmail): RenderedEmail {
  const site = a.domain ?? "your site";
  const copy = NOTHING_WRITTEN[a.reason];
  const paused =
    a.reason === "paused" && a.pausedUntil
      ? emailParagraph(`It is due to resume by itself on ${esc(dateLabel(`${a.pausedUntil}T00:00:00Z`))}.`)
      : "";
  return {
    subject: copy.subject(site),
    preheader: copy.what,
    footerNote: `Sent because ${site} is set to write on a schedule and it could not.`,
    html:
      eyebrow(site) +
      heading("Nothing was written this week") +
      emailParagraph(esc(copy.what)) +
      paused +
      emailParagraph(esc(copy.fix)) +
      emailButton(appLink(copy.path), copy.cta(copy.path)) +
      emailParagraph(
        `Nothing is wrong with the site or the account, and nothing has been lost. This is one email a week at most, and only while the site is set to write and cannot.`,
      ),
  };
}

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------
//
// Each one resolves its own recipients and hands `sendOnce` a stable
// `subjectId` - the thing the email is about, so a second email about the same
// fact is a duplicate and one about a new fact is not.

/** ISO week key, so the "nothing written" notice is weekly rather than daily. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Thursday of this week decides the year, per ISO 8601.
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export async function notifyDraftApproved(
  supabase: SupabaseClient,
  scope: { agencyId: string; workspaceId: string },
  data: DraftApprovedEmail,
): Promise<SendOnceOutcome> {
  const to = await agencyRecipients(supabase, scope.agencyId, scope.workspaceId);
  return sendOnce(
    supabase,
    to,
    {
      type: "draft_approved",
      subjectId: data.articleId,
      category: "drafts",
      agencyId: scope.agencyId,
      workspaceId: scope.workspaceId,
    },
    () => renderDraftApproved(data),
  );
}

export async function notifyArticlePublished(
  supabase: SupabaseClient,
  scope: { agencyId: string; workspaceId: string },
  data: ArticlePublishedEmail,
): Promise<SendOnceOutcome> {
  const to = await agencyRecipients(supabase, scope.agencyId, scope.workspaceId);
  return sendOnce(
    supabase,
    to,
    {
      type: "article_published",
      subjectId: data.articleId,
      category: "publishing",
      agencyId: scope.agencyId,
      workspaceId: scope.workspaceId,
    },
    () => renderArticlePublished(data),
  );
}

export async function notifyPublishFailed(
  supabase: SupabaseClient,
  scope: { agencyId: string; workspaceId: string },
  data: PublishFailedEmail,
  /** One per failure, not one per article: a retry that fails again is news. */
  attemptKey: string,
): Promise<SendOnceOutcome> {
  const to = await agencyRecipients(supabase, scope.agencyId, scope.workspaceId);
  return sendOnce(
    supabase,
    to,
    {
      type: "publish_failed",
      subjectId: `${data.articleId}:${attemptKey}`,
      category: "publishing",
      agencyId: scope.agencyId,
      workspaceId: scope.workspaceId,
    },
    () => renderPublishFailed(data),
  );
}

export async function notifyRefreshReady(
  supabase: SupabaseClient,
  scope: { agencyId: string; workspaceId: string },
  data: RefreshReadyEmail,
): Promise<SendOnceOutcome> {
  const to = await agencyRecipients(supabase, scope.agencyId, scope.workspaceId);
  return sendOnce(
    supabase,
    to,
    {
      type: "refresh_ready",
      subjectId: data.executionId,
      category: "improvements",
      agencyId: scope.agencyId,
      workspaceId: scope.workspaceId,
    },
    () => renderRefreshReady(data),
  );
}

export async function notifyPaymentFailed(
  supabase: SupabaseClient,
  agencyId: string,
  data: PaymentFailedEmail,
  /** `payment_failed_at`: one email per dunning episode, not per card retry. */
  episodeKey: string,
): Promise<SendOnceOutcome> {
  const to = await agencyBillingRecipients(supabase, agencyId);
  return sendOnce(
    supabase,
    to,
    { type: "payment_failed", subjectId: `${agencyId}:${episodeKey}`, category: "billing", agencyId },
    () => renderPaymentFailed(data),
  );
}

export async function notifySubscriptionCancelled(
  supabase: SupabaseClient,
  agencyId: string,
  data: SubscriptionCancelledEmail,
  subscriptionId: string,
): Promise<SendOnceOutcome> {
  const to = await agencyBillingRecipients(supabase, agencyId);
  return sendOnce(
    supabase,
    to,
    {
      type: "subscription_cancelled",
      subjectId: `${subscriptionId}:${data.endsAt ?? "no-date"}`,
      category: "billing",
      agencyId,
    },
    () => renderSubscriptionCancelled(data),
  );
}

export async function notifyAccountPaused(
  supabase: SupabaseClient,
  agencyId: string,
  data: AccountPausedEmail,
): Promise<SendOnceOutcome> {
  const to = await agencyBillingRecipients(supabase, agencyId);
  return sendOnce(
    supabase,
    to,
    { type: "account_paused", subjectId: `${agencyId}:${data.pausedUntil}`, category: "billing", agencyId },
    () => renderAccountPaused(data),
  );
}

export async function notifyPauseEnding(
  supabase: SupabaseClient,
  agencyId: string,
  data: PauseEndingEmail,
): Promise<SendOnceOutcome> {
  const to = await agencyBillingRecipients(supabase, agencyId);
  return sendOnce(
    supabase,
    to,
    { type: "pause_ending", subjectId: `${agencyId}:${data.pausedUntil}`, category: "billing", agencyId },
    () => renderPauseEnding(data),
  );
}

export async function notifyPlanChanged(
  supabase: SupabaseClient,
  agencyId: string,
  data: PlanChangedEmail,
  changeKey: string,
): Promise<SendOnceOutcome> {
  const to = await agencyBillingRecipients(supabase, agencyId);
  return sendOnce(
    supabase,
    to,
    { type: "plan_changed", subjectId: `${agencyId}:${changeKey}`, category: "billing", agencyId },
    () => renderPlanChanged(data),
  );
}

export async function notifyWelcome(
  supabase: SupabaseClient,
  userId: string,
  data: WelcomeEmail,
): Promise<SendOnceOutcome> {
  const to = await userEmail(supabase, userId);
  return sendOnce(supabase, [to], { type: "welcome", subjectId: userId, category: "account" }, () =>
    renderWelcome(data),
  );
}

export async function notifyPasswordChanged(
  supabase: SupabaseClient,
  data: PasswordChangedEmail,
): Promise<SendOnceOutcome> {
  // Keyed by the minute, not by the address alone: a second change an hour
  // later is a fact the account holder needs, and the same key would swallow it.
  const key = data.at.slice(0, 16);
  return sendOnce(
    supabase,
    [data.email],
    { type: "password_changed", subjectId: `${data.email}:${key}`, category: "account" },
    () => renderPasswordChanged(data),
  );
}

export async function notifyApiKeyCreated(
  supabase: SupabaseClient,
  agencyId: string,
  data: ApiKeyCreatedEmail,
  keyId: string,
): Promise<SendOnceOutcome> {
  const to = await agencyBillingRecipients(supabase, agencyId);
  return sendOnce(
    supabase,
    to,
    { type: "api_key_created", subjectId: keyId, category: "account", agencyId },
    () => renderApiKeyCreated(data),
  );
}

export async function notifyNothingWritten(
  supabase: SupabaseClient,
  scope: { agencyId: string; workspaceId: string },
  data: NothingWrittenEmail,
  now: Date = new Date(),
): Promise<SendOnceOutcome> {
  const to = await agencyRecipients(supabase, scope.agencyId, scope.workspaceId);
  return sendOnce(
    supabase,
    to,
    {
      type: "nothing_written",
      subjectId: `${scope.workspaceId}:${isoWeek(now)}`,
      category: "product",
      agencyId: scope.agencyId,
      workspaceId: scope.workspaceId,
    },
    () => renderNothingWritten(data),
  );
}
