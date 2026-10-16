// ---------------------------------------------------------------------------
// Auto-approve: the publish decision without the click, with stricter checks
// ---------------------------------------------------------------------------
//
// A workspace with `auto_approve` on has asked for its drafts to ship on their
// own. This module is the second writer of an approval, next to
// app/actions/publish.ts's approveArticle. It runs the button's checks (an
// active plan, no unsourced figure) and more, because nobody has read the
// draft: somewhere to publish, no named reviewer still to sign off, no failing
// audit item, and a score floor the workspace chose. A draft that fails any of
// them is not approved and says why on its own row
// (`auto_approve_hold_reason`), so a held draft is never a silent one.
//
// What it writes is `status = scheduled, scheduled_at = null`, which is what
// addToQueue writes after a human approval: the article enters the cadence
// queue and the publish cron's cadence phase decides the moment. The gate in
// core.ts (`scheduled` with `approved_by` set) passes because `approved_by` is
// the person who turned the rule on. Nothing here bypasses that gate; it is
// upstream of it.
//
// `decideAutoApproval` is pure so the rules are testable without a database.
// `runAutoApprovals` is the cron's entry point.

import type { SupabaseClient } from "@supabase/supabase-js";
import { factCheckArticle, autoApprovalBlocker, type FactCheckReport } from "@/lib/ai/fact-check";
import { tiptapToHtml } from "@/lib/cms/html";
import { auditArticle } from "@/lib/seo/article-audit";
import { removeTitleHeading } from "@/lib/content/on-page";
import { storedTrust, sensitiveTopicOf } from "@/lib/content/trust";
import { stripTags, decode } from "@/lib/content/enrich/html";
import type { ArticleResearch } from "@/lib/seo/research";
import { getQuota } from "@/lib/billing/quota";
import { getDestinations } from "./destinations";
import {
  CLEAN_APPROVALS_FOR_SENSITIVE,
  amountsIn,
  competitorsNamed,
  isCleanApproval,
  optedOut,
  pageTypeOf,
  pricesNotOnSite,
  ruleIsOff,
  type ApprovalRow,
  type ExceptionFacts,
  type OptOutRule,
} from "./auto-approve-exceptions";

/** The workspace columns the rule reads. */
export type AutoApproveRule = {
  auto_approve: boolean;
  auto_approve_hold_hours: number;
  auto_approve_min_seo: number;
  auto_approve_min_aeo: number | null;
  auto_approve_set_by: string | null;
  /**
   * The exception rules this site turned off (migration 119), as stored:
   * read through `optedOut`. Absent or malformed keeps every rule on.
   */
  auto_approve_exceptions?: unknown;
};

/** The article columns the rule reads. */
export type AutoApproveCandidate = {
  id: string;
  status: string;
  held_by: string | null;
  auto_approve_after: string | null;
  created_at: string | null;
  seo_score: number | null;
  aeo_score: number | null;
  /**
   * Message from `autoApprovalBlocker`, or null when the fact check passed.
   * Unlike a person's approve, a draft in a language the checker cannot read
   * is held here: nothing looked at its figures.
   */
  factCheckBlocker: string | null;
  /** Titles of audit items with status `fail`. */
  auditFailures: readonly string[];
  /** True when approving needs a plan the account does not have. */
  needsPlan: boolean;
  /**
   * True when the workspace has at least one CMS connection to publish
   * through. Auto-approve writes `status = scheduled`, and the publish cron
   * takes scheduled articles straight to `publishArticleCore`, which throws
   * "No CMS integration connected" and lands the row in `error`.
   */
  hasDestination: boolean;
  /** True when `auto_approve_set_by` is still a member of the account. */
  ruleOwnerIsMember: boolean;
  /**
   * The person the body names as its reviewer (lib/content/trust.ts), when
   * it names one. The line is a proposal: that person has to have read it.
   */
  reviewerToConfirm?: string | null;
  /**
   * The exception rules' facts (lib/publishing/auto-approve-exceptions.ts).
   * runAutoApprovals always computes them; absent means nothing fires.
   */
  exceptions?: ExceptionFacts;
};

/**
 * Why a draft was not approved, as a machine-readable word. The Needs you
 * inbox and the email actions are built on it; `reason` is the sentence a
 * person reads and `fix` the one thing to do about it.
 */
export type AutoApproveRefusalKind =
  | "rule_off"
  | "rule_owner"
  | "not_in_review"
  | "held"
  | "hold_window"
  | "no_plan"
  | "no_destination"
  | "facts"
  | "first_draft"
  | "sensitive"
  | "price"
  | "competitor"
  | "page_type"
  | "publish_failures"
  | "reviewer"
  | "audit"
  | "seo_floor"
  | "aeo_floor";

export type AutoApproveDecision =
  | { approve: true }
  | { approve: false; kind: AutoApproveRefusalKind; reason: string; fix: string };

function refuse(kind: AutoApproveRefusalKind, reason: string, fix: string): AutoApproveDecision {
  return { approve: false, kind, reason, fix };
}

/**
 * The reviewer the draft names, when its body still carries the name the
 * generator wrote in (lib/content/trust.ts). Null when the trust decision
 * named nobody, or a person has since taken the line out.
 */
export function reviewerNamedIn(html: string, research: unknown): string | null {
  const name = storedTrust(research)?.reviewer?.name;
  if (!name || !html) return null;
  return decode(stripTags(html)).replace(/\s+/g, " ").includes(name.replace(/\s+/g, " ")) ? name : null;
}

const SENSITIVE_WORD: Record<string, string> = {
  health: "health",
  legal: "legal",
  financial: "money",
  safety: "safety",
};

/**
 * Should this draft be approved now?
 *
 * The hold window is the one soft rule: it is what makes "you saw it first"
 * true, because the drafted email went out when the draft was written and the
 * window is the time a person has to hold it. Everything after it is a hard
 * check: the plan and the unsourced figure are the human approve action's
 * own, the rest are stricter because nobody has read the draft. The
 * exception rules (lib/publishing/auto-approve-exceptions.ts) come after the
 * fact check, in the order a person would want to hear them.
 */
export function decideAutoApproval(
  rule: AutoApproveRule,
  a: AutoApproveCandidate,
  now: Date,
): AutoApproveDecision {
  if (!rule.auto_approve) return refuse("rule_off", "auto-approve is off for this workspace", "Turn on Publish automatically in this site's settings.");
  if (!rule.auto_approve_set_by) return refuse("rule_owner", "no one is recorded as having turned auto-approve on", "Save Publish automatically again in this site's settings.");
  if (!a.ruleOwnerIsMember) return refuse("rule_owner", "the person who set the rule is no longer a member; re-confirm it in workspace settings", "Save Publish automatically again in this site's settings.");
  if (a.status !== "review") return refuse("not_in_review", `status is ${a.status}, not review`, "Nothing to do: only drafts in review are approved automatically.");
  if (a.held_by) return refuse("held", "held by a person", "Release the hold, or approve it yourself.");

  // Drafts written before the workspace turned the rule on have no
  // auto_approve_after; the hold counts from when they were written.
  const holdEnds = a.auto_approve_after
    ? new Date(a.auto_approve_after)
    : a.created_at
      ? new Date(new Date(a.created_at).getTime() + rule.auto_approve_hold_hours * 3_600_000)
      : null;
  if (!holdEnds || Number.isNaN(holdEnds.getTime())) return refuse("hold_window", "no hold window recorded", "Approve it yourself, or save Publish automatically again.");
  if (holdEnds > now) return refuse("hold_window", `hold window ends ${holdEnds.toISOString()}`, "Nothing to do: it ships after the hold unless you hold it.");

  if (a.needsPlan) return refuse("no_plan", "no active plan; choose one on the Billing page", "Choose a plan on the Billing page.");

  // Nowhere to publish is not a reason to approve and find out. Auto-approve
  // means "ship it without asking me"; with no CMS connected the ship step
  // throws and the publish cron writes `status = error`, so the customer's
  // first drafts would be marked failed against a decision they never made.
  // Held in `review` instead, where connecting a CMS clears it on the next
  // pass and approving by hand is still one click.
  if (!a.hasDestination) {
    return refuse(
      "no_destination",
      "no CMS connected to publish through; connect one in Integrations, or approve it yourself and record where you published it",
      "Connect a place to publish in Integrations.",
    );
  }
  if (a.factCheckBlocker) return refuse("facts", a.factCheckBlocker, "Add a source for the figure or take it out, then approve.");

  // Exceptions: the drafts a person is asked about under autopilot. Absent
  // facts (a caller that did not compute them) fire nothing.
  const x = a.exceptions;
  if (x) {
    const optOuts = optedOut(rule.auto_approve_exceptions);
    const off = (r: OptOutRule) => ruleIsOff(r, optOuts, x.cleanApprovals);
    if (x.firstDraftOnSite) {
      return refuse("first_draft", "the first draft on this site waits for a person, so the voice and audience are set once", "Read it and approve it, or say what to change.");
    }
    if (x.sensitive && !off("sensitive")) {
      return refuse(
        "sensitive",
        `${SENSITIVE_WORD[x.sensitive.kind] ?? x.sensitive.kind} advice: ${x.sensitive.evidence}`,
        x.cleanApprovals >= CLEAN_APPROVALS_FOR_SENSITIVE
          ? "Read it and approve it, or turn this rule off in Publish automatically."
          : "Read it and approve it.",
      );
    }
    if (x.pricesNotOnSite.length && !off("price")) {
      return refuse("price", `names a price not on your site: ${x.pricesNotOnSite.join(", ")}`, "Check the price, then approve, or take it out.");
    }
    if (x.competitorsNamed.length && !off("competitor")) {
      return refuse("competitor", `names a competitor: ${x.competitorsNamed.join(", ")}`, "Check what it says about them, then approve, or take the mention out.");
    }
    if (x.newPageType && !off("page_type")) {
      return refuse("page_type", `a page type this site has never published: ${x.newPageType}`, "Read it and approve it; the next one of this type ships on its own.");
    }
    if (x.failedPublishes) {
      return refuse(
        "publish_failures",
        `the last two publishes on this site failed${x.failedPublishes.lastError ? `: ${x.failedPublishes.lastError}` : ""}`,
        "Fix the connection in Integrations and retry the failed article.",
      );
    }
  }

  // "Reviewed by" on a page nobody opened is a credential the named person
  // never gave. The generator writes the line from the site's own team page
  // and asks for that person's sign-off; auto-approve cannot get it. No
  // reviewer found is a review note, not a hold (decided 2026-09-28).
  if (a.reviewerToConfirm) {
    return refuse(
      "reviewer",
      `names ${a.reviewerToConfirm} as its reviewer; approve it yourself once they have reviewed it, or remove the line`,
      `Approve it once ${a.reviewerToConfirm} has reviewed it, or remove the line.`,
    );
  }
  if (a.auditFailures.length) return refuse("audit", `audit: ${a.auditFailures.join("; ")}`, "Fix the failing audit items in the editor, then approve.");

  const seo = a.seo_score ?? 0;
  if (seo < rule.auto_approve_min_seo) {
    return refuse("seo_floor", `SEO score ${seo} is below the ${rule.auto_approve_min_seo} this workspace requires`, "Improve it in the editor, or approve it yourself.");
  }
  if (rule.auto_approve_min_aeo != null) {
    if (a.aeo_score == null) return refuse("aeo_floor", `AEO score is not measured and this workspace requires ${rule.auto_approve_min_aeo}`, "Score it in the editor, or approve it yourself.");
    if (a.aeo_score < rule.auto_approve_min_aeo) {
      return refuse("aeo_floor", `AEO score ${a.aeo_score} is below the ${rule.auto_approve_min_aeo} this workspace requires`, "Improve it in the editor, or approve it yourself.");
    }
  }
  return { approve: true };
}

export type AutoApproveResult = {
  articleId: string;
  workspaceId: string;
  outcome: "approved" | "held" | "error";
  detail?: string;
  /** Set on a hold: which rule held it (AutoApproveRefusalKind). */
  kind?: AutoApproveRefusalKind;
};

type WorkspaceRow = AutoApproveRule & {
  id: string;
  account_id: string;
  domain: string | null;
  status: string;
  /** Read so the fact check and the audit use the site's language rules. */
  language: string | null;
  /** Competitors and the business description the exception rules read. */
  business_profile: unknown;
};

type ArticleRow = {
  id: string;
  workspace_id: string;
  status: string;
  held_by: string | null;
  auto_approve_after: string | null;
  created_at: string | null;
  seo_score: number | null;
  aeo_score: number | null;
  content: Record<string, unknown> | null;
  research: ArticleResearch | null;
  keyword: string | null;
  title: string | null;
  slug: string | null;
  meta_description: string | null;
  featured_image_url: string | null;
  auto_approve_hold_reason: string | null;
  article_type: string | null;
  article_subtype: string | null;
};

/**
 * One pass over every workspace with the rule on. Called by the publish cron
 * before its cadence phase, so a draft approved here can ship in the same run.
 *
 * Per workspace the plan check is made once; per article the fact check is
 * re-run on the content as it is now (a reviewer may have sourced a figure
 * since generation) and the fresh report is stored, same as the human path.
 * A skip writes its reason to the row and clears nothing else; a later pass
 * re-evaluates from scratch.
 */
export async function runAutoApprovals(supabase: SupabaseClient, now: Date): Promise<AutoApproveResult[]> {
  const out: AutoApproveResult[] = [];

  const { data: wsRows, error: wsError } = await supabase
    .from("workspaces")
    .select("id, account_id, domain, language, status, auto_approve, auto_approve_hold_hours, auto_approve_min_seo, auto_approve_min_aeo, auto_approve_set_by, auto_approve_exceptions, business_profile")
    .eq("auto_approve", true)
    .eq("status", "on");
  if (wsError) throw new Error(`auto-approve: workspaces: ${wsError.message}`);

  for (const ws of (wsRows ?? []) as WorkspaceRow[]) {
    const { data: articles, error: artError } = await supabase
      .from("articles")
      .select("id, workspace_id, status, held_by, auto_approve_after, created_at, seo_score, aeo_score, content, research, keyword, title, slug, meta_description, featured_image_url, auto_approve_hold_reason, article_type, article_subtype")
      .eq("workspace_id", ws.id)
      .eq("status", "review")
      .is("held_by", null)
      .order("created_at", { ascending: true });
    if (artError) {
      out.push({ articleId: "", workspaceId: ws.id, outcome: "error", detail: `articles: ${artError.message}` });
      continue;
    }
    if (!articles?.length) continue;

    // Once per workspace: whether approving needs a plan (cron = no session,
    // so `null`, as the other crons pass it) and whether the rule's owner is
    // still on the account.
    let needsPlan = false;
    try {
      needsPlan = (await getQuota(supabase, ws.account_id, null)).reason === "no-plan";
    } catch (err) {
      out.push({ articleId: "", workspaceId: ws.id, outcome: "error", detail: `quota: ${err instanceof Error ? err.message : "unknown"}` });
      continue;
    }
    // Once per workspace, like the plan check: the same list `publishCore`
    // resolves against, so the rule and the publish path cannot disagree about
    // whether there is anywhere to send this.
    let hasDestination = false;
    try {
      hasDestination = (await getDestinations(supabase, ws.id)).length > 0;
    } catch (err) {
      out.push({ articleId: "", workspaceId: ws.id, outcome: "error", detail: `destinations: ${err instanceof Error ? err.message : "unknown"}` });
      continue;
    }

    let ruleOwnerIsMember = false;
    if (ws.auto_approve_set_by) {
      const { data: member } = await supabase
        .from("account_members")
        .select("user_id")
        .eq("account_id", ws.account_id)
        .eq("user_id", ws.auto_approve_set_by)
        .maybeSingle();
      ruleOwnerIsMember = Boolean(member);
    }

    // Once per workspace: what the exception rules compare a draft against.
    let site: SiteHistory;
    try {
      site = await siteHistory(supabase, ws);
    } catch (err) {
      out.push({ articleId: "", workspaceId: ws.id, outcome: "error", detail: `exceptions: ${err instanceof Error ? err.message : "unknown"}` });
      continue;
    }

    for (const article of articles as ArticleRow[]) {
      try {
        const html = article.content ? tiptapToHtml(article.content) : "";
        const report = html ? factCheckArticle(html, article.research ?? undefined, ws.language) : null;
        if (report) {
          await supabase
            .from("articles")
            .update({ fact_checks: report, fact_check_verdict: report.verdict })
            .eq("id", article.id);
        }
        // Audited as it will publish: the publisher takes the title's <h1>
        // out of the body (lib/content/on-page.ts), and the title is the H1.
        const audit = html
          ? auditArticle({
              html: removeTitleHeading(html, article.title).html,
              keyword: article.keyword ?? "",
              siteDomain: ws.domain,
              title: article.title,
              metaDescription: article.meta_description,
              slug: article.slug,
              featuredImageUrl: article.featured_image_url,
              language: ws.language,
              titleIsPageH1: true,
            })
          : null;

        const decision = decideAutoApproval(
          ws,
          {
            ...article,
            factCheckBlocker: report ? autoApprovalBlocker(report) : "draft has no content",
            auditFailures: audit ? audit.items.filter((i) => i.status === "fail").map((i) => i.label) : [],
            needsPlan,
            hasDestination,
            ruleOwnerIsMember,
            reviewerToConfirm: reviewerNamedIn(html, article.research),
            exceptions: exceptionFacts(site, ws, article, html, report),
          },
          now,
        );

        if (!decision.approve) {
          // A hold-window skip is not news; a check failing is. Either way the
          // row carries the reason, and only when it changed, to keep the
          // update count honest.
          if (article.auto_approve_hold_reason !== decision.reason) {
            await supabase
              .from("articles")
              .update({ auto_approve_hold_reason: decision.reason })
              .eq("id", article.id)
              .eq("status", "review");
          }
          out.push({ articleId: article.id, workspaceId: ws.id, outcome: "held", detail: decision.reason, kind: decision.kind });
          continue;
        }

        // The same write addToQueue makes after a human approval, plus the
        // sign-off. `.eq("status","review").is("held_by",null)` makes a person
        // approving or holding in the same second win: this update then
        // matches zero rows and does nothing.
        const { data: moved, error: moveError } = await supabase
          .from("articles")
          .update({
            status: "scheduled",
            scheduled_at: null,
            approved_by: ws.auto_approve_set_by,
            approved_at: now.toISOString(),
            approval_kind: "auto",
            auto_approve_hold_reason: null,
            updated_at: now.toISOString(),
          })
          .eq("id", article.id)
          .eq("status", "review")
          .is("held_by", null)
          .select("id");
        if (moveError) throw new Error(moveError.message);
        out.push({
          articleId: article.id,
          workspaceId: ws.id,
          outcome: moved?.length ? "approved" : "held",
          detail: moved?.length ? undefined : "changed under us; left as is",
        });
      } catch (err) {
        out.push({ articleId: article.id, workspaceId: ws.id, outcome: "error", detail: err instanceof Error ? err.message : "unknown error" });
      }
    }
  }

  return out;
}

/** What the exception rules compare every draft on one site against. */
type SiteHistory = {
  firstDraftOnSite: boolean;
  livePageTypes: Set<string>;
  cleanApprovals: number;
  /** Every amount the site's own text states (lib/publishing/auto-approve-exceptions.ts). */
  siteAmounts: Set<number>;
  failedPublishes: ExceptionFacts["failedPublishes"];
};

function stringsIn(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 5 || v == null) return out;
  if (typeof v === "string") out.push(v);
  else if (typeof v === "number") out.push(String(v));
  else if (Array.isArray(v)) v.forEach((x) => stringsIn(x, out, depth + 1));
  else if (typeof v === "object") Object.values(v as Record<string, unknown>).forEach((x) => stringsIn(x, out, depth + 1));
  return out;
}

/**
 * Once per workspace: its approval history, the amounts its own pages state,
 * and its last two publishes. Read only, from what earlier crawls and
 * publishes stored; nothing is fetched. Throws when a read fails, so the
 * workspace is skipped rather than decided on half the facts.
 */
async function siteHistory(supabase: SupabaseClient, ws: WorkspaceRow): Promise<SiteHistory> {
  const [history, pages, voice, log] = await Promise.all([
    supabase
      .from("articles")
      .select("status, approval_kind, approved_at, published_at, person_edited_at, article_type, article_subtype")
      .eq("workspace_id", ws.id)
      .or("approved_at.not.is.null,status.eq.live"),
    supabase.from("site_pages").select("title, h1, meta_description, extract").eq("workspace_id", ws.id).limit(1000),
    supabase.from("voice_profiles").select("sample_text").eq("workspace_id", ws.id).maybeSingle(),
    // Pushes only: a find on the customer's own site is not an attempt, and a
    // webhook row is one HTTP delivery of a publish, not a publish.
    supabase
      .from("publish_log")
      .select("status, error")
      .eq("workspace_id", ws.id)
      .eq("source", "push")
      .neq("triggered_by", "webhook")
      .order("created_at", { ascending: false })
      .limit(2),
  ]);
  for (const r of [history, pages, voice, log]) if (r.error) throw new Error(r.error.message);

  const rows = (history.data ?? []) as (ApprovalRow & { article_type: string | null; article_subtype: string | null })[];
  const livePageTypes = new Set<string>();
  for (const r of rows) {
    const t = r.status === "live" ? pageTypeOf(r.article_type, r.article_subtype) : null;
    if (t) livePageTypes.add(t);
  }
  const siteText = [
    ...stringsIn(pages.data ?? []),
    (voice.data as { sample_text?: string | null } | null)?.sample_text ?? "",
    ...stringsIn(ws.business_profile),
  ].join("\n");
  const last = (log.data ?? []) as { status: string; error: string | null }[];
  return {
    firstDraftOnSite: rows.length === 0,
    livePageTypes,
    cleanApprovals: rows.filter(isCleanApproval).length,
    siteAmounts: amountsIn(siteText),
    failedPublishes: last.length === 2 && last.every((r) => r.status === "error") ? { lastError: last[0].error } : null,
  };
}

/** One draft's exception facts, from its site's history and its own body. */
function exceptionFacts(
  site: SiteHistory,
  ws: WorkspaceRow,
  article: ArticleRow,
  html: string,
  report: FactCheckReport | null,
): ExceptionFacts {
  const profile = (ws.business_profile && typeof ws.business_profile === "object" ? ws.business_profile : {}) as {
    competitors?: unknown;
    competitorNames?: unknown;
  };
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  // A figure the cited page was opened and found to carry is someone else's
  // number (a market size, a public fee), not an offer this business makes.
  const money = (report?.claims ?? [])
    .filter((c) => c.kind === "money" && c.status !== "verified")
    .flatMap((c) => c.figures);
  const pageType = pageTypeOf(article.article_type, article.article_subtype);
  return {
    firstDraftOnSite: site.firstDraftOnSite,
    sensitive: sensitiveTopicOf({ keyword: article.keyword ?? "", title: article.title, profile: ws.business_profile, language: ws.language }).topic,
    pricesNotOnSite: pricesNotOnSite(money, site.siteAmounts),
    competitorsNamed: html
      ? competitorsNamed({ html, keyword: article.keyword, competitors: list(profile.competitors), names: list(profile.competitorNames) })
      : [],
    newPageType: pageType && !site.livePageTypes.has(pageType) ? pageType : null,
    failedPublishes: site.failedPublishes,
    cleanApprovals: site.cleanApprovals,
  };
}
