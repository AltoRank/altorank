// ---------------------------------------------------------------------------
// An article went live: the receipt
// ---------------------------------------------------------------------------
//
// A customer can copy a draft onto their own site by hand. The nightly check
// (lib/found-on-site/detect.ts) finds the copy and flips the article to live;
// before this, that was all - no publish_log row, no email, no rank tracking.
//
// So the transition calls this, once:
//
//   1. a publish_log row, source 'found_on_site' with the page's URL. It is
//      the claim: the partial unique index on (article_id, url) (migration
//      105) lets one insert win, and everything below runs only for the
//      winner. Exactly once per article and page, whoever calls it twice.
//   2. the article's keyword row is marked `shipped` (created if the article
//      never had one), and what it was before is kept on the article's
//      `found_on_site_prior` so "Not my article" can put it back. Whether
//      that puts the term in the nightly rank check is not assumed: it is
//      read from cron/serp's own selection (lib/seo/tracked-keywords.ts),
//      and cron/serp only buys for accounts entitled to scheduled work. No
//      SERP is bought here.
//   3. the owner's email, "We found your article live at <url>", with one
//      line asking for the trial when the account has not started it. It
//      says rank tracking started only when cron/serp will check the term
//      tonight. Optional mail ("publishing"): an owner who opted out is not
//      sent it. A send that reached nobody is raised to system_events.
//   4. the operators' note (ADMIN_EMAILS; nothing when unset).
//
// Only the found-on-site path calls it. The publishers already write their
// own publish_log row per attempt and announce an unattended publish through
// lib/email/article-events.ts, keyed by article; routing them through here as
// well would be a second email for the same publish.
//
// Never throws. It runs after the find is recorded, and a mail provider or a
// keyword write failing must not turn a recorded find into a failed night.
// What went wrong is returned for the cron's log and raised to system_events.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getQuota, entitledToScheduledWork, type Quota } from "@/lib/billing/quota";
import {
  notifyArticleFoundLive,
  notifyOperatorsArticleFoundLive,
  type AccountStanding,
} from "@/lib/email/lifecycle";
import { describeSendOutcome, type SendOnceOutcome } from "@/lib/email/send-once";
import { recordEvent } from "@/lib/observability/record";
import { wouldTrackNightly } from "@/lib/seo/tracked-keywords";

export type ArticleLiveSource = "found_on_site";

/** Whether the article's keyword is in the nightly rank check, and why not when it is not. */
export type RankTracking =
  | "nightly" // cron/serp selects the term and the account is entitled
  | "after-trial" // cron/serp selects the term once the account has a plan
  | "not-tracked" // cron/serp would not select the term (paused site, no domain, over the cap)
  | "no-keyword" // the article was written for no term
  | "failed"; // the keyword row could not be written

export interface ArticleLiveOutcome {
  /** False when this article and page were already announced, or the claim could not be written. */
  fired: boolean;
  detail?: string;
  standing?: AccountStanding;
  tracking?: RankTracking;
  /** describeSendOutcome of the owner email. */
  email?: string;
  operators?: string;
}

/**
 * The article's keyword row before the receipt marked it shipped, kept on
 * `articles.found_on_site_prior.keyword` for the undo. `status: null` means
 * the receipt created the row.
 */
export type PriorKeyword = { id: string; status: string | null };

const UNIQUE_VIOLATION = "23505";

export async function onArticleLive(
  supabase: SupabaseClient,
  article: { id: string; workspaceId: string },
  opts: { source: ArticleLiveSource; url: string },
): Promise<ArticleLiveOutcome> {
  try {
    return await fire(supabase, article, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordEvent(
      {
        level: "error",
        source: "found_on_site.receipt",
        message: `The receipt for a find did not finish: ${message}`,
        workspaceId: article.workspaceId,
        context: { articleId: article.id, url: opts.url },
      },
      supabase,
    );
    return { fired: false, detail: `receipt failed: ${message}` };
  }
}

async function fire(
  supabase: SupabaseClient,
  article: { id: string; workspaceId: string },
  opts: { source: ArticleLiveSource; url: string },
): Promise<ArticleLiveOutcome> {
  // 1. The claim. Before anything a person sees, so a second caller (a
  // re-run, a find undone and found again at the same page) stops here.
  const { error: claimErr } = await supabase.from("publish_log").insert({
    article_id: article.id,
    workspace_id: article.workspaceId,
    status: "success",
    triggered_by: "cron",
    source: opts.source,
    url: opts.url,
  });
  if (claimErr) {
    if (claimErr.code === UNIQUE_VIOLATION) return { fired: false, detail: "already announced for this page" };
    // Without the row there is no "once", so nothing is sent. Raised: the
    // find stands, and only the receipt is missing.
    await recordEvent(
      {
        level: "error",
        source: "found_on_site.receipt",
        message: `A find could not be logged, so no receipt was sent: ${claimErr.message}`,
        workspaceId: article.workspaceId,
        context: { articleId: article.id, url: opts.url, code: claimErr.code ?? null },
      },
      supabase,
    );
    return { fired: false, detail: `could not log the find: ${claimErr.message}` };
  }

  const { data: row, error: articleErr } = await supabase
    .from("articles")
    .select("id, title, keyword, keyword_id, workspace_id, found_on_site_prior")
    .eq("id", article.id)
    .maybeSingle();
  if (articleErr) throw new Error(`could not read the article: ${articleErr.message}`);
  const { data: ws, error: wsErr } = await supabase
    .from("workspaces")
    .select("id, domain, account_id, status")
    .eq("id", article.workspaceId)
    .maybeSingle();
  if (wsErr) throw new Error(`could not read the site: ${wsErr.message}`);
  if (!row || !ws?.account_id) return { fired: true, detail: "logged; the article or its site is gone, nobody to tell" };

  const accountId = ws.account_id as string;
  const keyword = typeof row.keyword === "string" && row.keyword.trim() ? row.keyword.trim() : null;

  // Where the account stands. A cron is nobody's session, so the operator
  // bypass is the account's own (getQuota with a null email).
  let quota: Quota | null = null;
  try {
    quota = await getQuota(supabase, accountId, null);
  } catch {
    quota = null;
  }
  const standing = standingOf(quota);

  // 2. Rank tracking.
  let tracking: RankTracking;
  let trackingWhy: string | null = null;
  if (!keyword) {
    tracking = "no-keyword";
  } else {
    const marked = await markKeywordShipped(supabase, article.workspaceId, keyword, (row.keyword_id as string | null) ?? null);
    if (!marked.ok) {
      tracking = "failed";
      await recordEvent(
        {
          level: "warn",
          source: "found_on_site.receipt",
          message: `A found article's keyword could not be marked shipped: ${marked.error}`,
          workspaceId: article.workspaceId,
          context: { articleId: article.id },
        },
        supabase,
      );
    } else {
      await rememberPriorKeyword(supabase, article.id, row.found_on_site_prior, marked.prior);
      // What cron/serp will actually select, not what marking a row should
      // mean: a paused site, a site with no domain or the cap keep it out.
      const check = await wouldTrackNightly(
        supabase,
        { id: article.workspaceId, domain: (ws.domain as string | null) ?? null, status: (ws.status as string | null) ?? null },
        marked.prior.id,
      );
      if (!check.tracked) {
        tracking = "not-tracked";
        trackingWhy = check.why;
      } else {
        tracking = quota && entitledToScheduledWork(quota) ? "nightly" : "after-trial";
      }
    }
  }

  // 3. The owner. The email only says rank tracking started when it did, and
  // only promises it after the trial when cron/serp would pick the term up.
  const scope = { accountId, workspaceId: article.workspaceId };
  const emailData = {
    domain: (ws.domain as string | null) ?? null,
    title: (row.title as string | null) ?? "Your article",
    articleId: article.id,
    url: opts.url,
    keyword: tracking === "nightly" ? keyword : null,
    tracksAfterPlan: tracking === "after-trial",
    standing,
  };
  let owner: SendOnceOutcome;
  try {
    owner = await notifyArticleFoundLive(supabase, scope, emailData);
  } catch (err) {
    owner = { sent: 0, skipped: 0, failed: 1, lastError: err instanceof Error ? err.message : String(err) };
  }
  const email = describeSendOutcome(owner);
  // The publish_log claim is held, so no later night sends this. Nobody
  // reached (no owner address, the member list unreadable, the provider
  // refusing) is raised rather than left in a cron's JSON. An owner who
  // opted out counts as skipped, not as missing.
  if (owner.failed > 0 || owner.sent + owner.skipped === 0) {
    await recordEvent(
      {
        level: "warn",
        source: "found_on_site.receipt",
        message: `A found article's owner email reached nobody: ${email}`,
        workspaceId: article.workspaceId,
        context: { articleId: article.id, url: opts.url, accountId },
      },
      supabase,
    );
  }

  // 4. The operators.
  const operators = describeSendOutcome(
    await notifyOperatorsArticleFoundLive(supabase, scope, {
      ...emailData,
      keyword,
      ownerEmail: email,
      tracking: trackingWhy ? `${tracking} (${trackingWhy})` : tracking,
      account: accountLabel(quota),
    }),
  );

  return { fired: true, standing, tracking, email, operators };
}

/** Where an account stands for the email's one line. See AccountStanding. */
export function standingOf(quota: Pick<Quota, "reason" | "trialEligible"> | null): AccountStanding {
  if (!quota) return "unknown";
  if (quota.reason !== "no-plan") return "paying";
  return quota.trialEligible ? "trial-eligible" : "lapsed";
}

/**
 * The operators' label, finer than the owner's standing: whether a find
 * converted is read off this, so a running trial is not called paying.
 */
export function accountLabel(quota: Pick<Quota, "reason" | "trialEligible" | "trial" | "plan"> | null): string {
  if (!quota) return "unknown (the plan could not be read)";
  switch (quota.reason) {
    case "plan":
      return quota.trial ? `trialing${quota.plan ? ` (${quota.plan})` : ""}` : `paying${quota.plan ? ` (${quota.plan})` : ""}`;
    case "operator":
      return "operator account";
    case "self-host":
      return "self-hosted";
    case "no-plan":
      return quota.trialEligible ? "no plan, trial not started" : "no plan, trial or plan ended";
  }
}

/**
 * Mark the article's keyword row `shipped`, which is what the keyword is now
 * (and takes it out of the new/stored/planned pools the planner drafts from).
 * By the article's keyword_id when it has one, else by its term, else a new
 * row. Returns the row and the status it had, for the undo.
 */
async function markKeywordShipped(
  supabase: SupabaseClient,
  workspaceId: string,
  term: string,
  keywordId: string | null,
): Promise<{ ok: true; prior: PriorKeyword } | { ok: false; error: string }> {
  const mark = async (id: string, prior: string | null) => {
    const { error } = await supabase.from("keywords").update({ status: "shipped" }).eq("id", id).eq("workspace_id", workspaceId);
    return error ? ({ ok: false, error: error.message } as const) : ({ ok: true, prior: { id, status: prior } } as const);
  };

  if (keywordId) {
    const { data, error } = await supabase
      .from("keywords")
      .select("id, status")
      .eq("id", keywordId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (data) return mark(data.id as string, data.status as string);
  }
  const { data: existing, error: findErr } = await supabase
    .from("keywords")
    .select("id, status")
    .eq("workspace_id", workspaceId)
    .ilike("term", term.replace(/[\\%_]/g, (c) => `\\${c}`))
    .limit(1);
  if (findErr) return { ok: false, error: findErr.message };
  const hit = (existing ?? [])[0] as { id: string; status: string } | undefined;
  if (hit) return mark(hit.id, hit.status);

  const { data: inserted, error: insertErr } = await supabase
    .from("keywords")
    .insert({ workspace_id: workspaceId, term, status: "shipped", source_type: "generate" })
    .select("id");
  if (!insertErr) {
    const id = (inserted ?? [])[0]?.id as string | undefined;
    return id ? { ok: true, prior: { id, status: null } } : { ok: false, error: "the new keyword row came back without an id" };
  }
  if (insertErr.code !== UNIQUE_VIOLATION) return { ok: false, error: insertErr.message };
  // Written by someone else between the read and the insert: mark that one.
  const { data: raced, error: racedErr } = await supabase
    .from("keywords")
    .select("id, status")
    .eq("workspace_id", workspaceId)
    .eq("term", term)
    .maybeSingle();
  if (racedErr || !raced) return { ok: false, error: racedErr?.message ?? "the keyword row vanished" };
  return mark(raced.id as string, raced.status as string);
}

/**
 * Keep the keyword's previous status beside the article's, so "Not my
 * article" (lib/found-on-site/undo.ts) can put it back. Best effort: a
 * failure leaves the undo restoring only the article, as before.
 */
async function rememberPriorKeyword(
  supabase: SupabaseClient,
  articleId: string,
  prior: unknown,
  keyword: PriorKeyword,
): Promise<void> {
  if (!prior || typeof prior !== "object") return;
  // The first receipt's answer stands: a second one (another page for the
  // same find) sees the row already shipped and would record that instead.
  if ((prior as Record<string, unknown>).keyword) return;
  const { error } = await supabase
    .from("articles")
    .update({ found_on_site_prior: { ...(prior as Record<string, unknown>), keyword } })
    .eq("id", articleId)
    .not("found_on_site_at", "is", null);
  if (error) console.warn(`[found-on-site] could not keep ${articleId}'s prior keyword: ${error.message}`);
}

/** One line for the cron's JSON. */
export function describeArticleLive(o: ArticleLiveOutcome): string {
  if (!o.fired) return o.detail ?? "not fired";
  if (o.detail) return o.detail;
  return [`receipt: ${o.email ?? "no email"}`, `rank tracking ${o.tracking}`, `account ${o.standing}`, `operators: ${o.operators ?? "none"}`].join("; ");
}
