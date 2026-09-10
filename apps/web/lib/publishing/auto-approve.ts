// ---------------------------------------------------------------------------
// Auto-approve: the publish decision without the click, with the same checks
// ---------------------------------------------------------------------------
//
// A workspace with `auto_approve` on has asked for its drafts to ship on their
// own. This module is the second writer of an approval, next to
// app/actions/publish.ts's approveArticle, and it runs the same checks in the
// same order: an active plan, somewhere to publish, no unsourced figure, no
// failing audit item, and a score floor the workspace chose. A draft that
// fails any of them is not approved and says why on its own row
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
import { factCheckArticle, approvalBlocker } from "@/lib/ai/fact-check";
import { tiptapToHtml } from "@/lib/cms/html";
import { auditArticle } from "@/lib/seo/article-audit";
import type { ArticleResearch } from "@/lib/seo/research";
import { getQuota } from "@/lib/billing/quota";
import { getDestinations } from "./destinations";

/** The workspace columns the rule reads. */
export type AutoApproveRule = {
  auto_approve: boolean;
  auto_approve_hold_hours: number;
  auto_approve_min_seo: number;
  auto_approve_min_aeo: number | null;
  auto_approve_set_by: string | null;
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
  /** Message from `approvalBlocker`, or null when the fact check passed. */
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
};

export type AutoApproveDecision =
  | { approve: true }
  | { approve: false; reason: string };

/**
 * Should this draft be approved now?
 *
 * The hold window is the one soft rule: it is what makes "you saw it first"
 * true, because the drafted email went out when the draft was written and the
 * window is the time a person has to hold it. Everything after it is a hard
 * check the human approve action also runs.
 */
export function decideAutoApproval(
  rule: AutoApproveRule,
  a: AutoApproveCandidate,
  now: Date,
): AutoApproveDecision {
  if (!rule.auto_approve) return { approve: false, reason: "auto-approve is off for this workspace" };
  if (!rule.auto_approve_set_by) return { approve: false, reason: "no one is recorded as having turned auto-approve on" };
  if (!a.ruleOwnerIsMember) return { approve: false, reason: "the person who set the rule is no longer a member; re-confirm it in workspace settings" };
  if (a.status !== "review") return { approve: false, reason: `status is ${a.status}, not review` };
  if (a.held_by) return { approve: false, reason: "held by a person" };

  // Drafts written before the workspace turned the rule on have no
  // auto_approve_after; the hold counts from when they were written.
  const holdEnds = a.auto_approve_after
    ? new Date(a.auto_approve_after)
    : a.created_at
      ? new Date(new Date(a.created_at).getTime() + rule.auto_approve_hold_hours * 3_600_000)
      : null;
  if (!holdEnds || Number.isNaN(holdEnds.getTime())) return { approve: false, reason: "no hold window recorded" };
  if (holdEnds > now) return { approve: false, reason: `hold window ends ${holdEnds.toISOString()}` };

  if (a.needsPlan) return { approve: false, reason: "no active plan; choose one on the Billing page" };

  // Nowhere to publish is not a reason to approve and find out. Auto-approve
  // means "ship it without asking me"; with no CMS connected the ship step
  // throws and the publish cron writes `status = error`, so the customer's
  // first drafts would be marked failed against a decision they never made.
  // Held in `review` instead, where connecting a CMS clears it on the next
  // pass and approving by hand is still one click.
  if (!a.hasDestination) {
    return {
      approve: false,
      reason:
        "no CMS connected to publish through; connect one in Integrations, or approve it yourself and record where you published it",
    };
  }
  if (a.factCheckBlocker) return { approve: false, reason: a.factCheckBlocker };
  if (a.auditFailures.length) return { approve: false, reason: `audit: ${a.auditFailures.join("; ")}` };

  const seo = a.seo_score ?? 0;
  if (seo < rule.auto_approve_min_seo) {
    return { approve: false, reason: `SEO score ${seo} is below the ${rule.auto_approve_min_seo} this workspace requires` };
  }
  if (rule.auto_approve_min_aeo != null) {
    if (a.aeo_score == null) return { approve: false, reason: `AEO score is not measured and this workspace requires ${rule.auto_approve_min_aeo}` };
    if (a.aeo_score < rule.auto_approve_min_aeo) {
      return { approve: false, reason: `AEO score ${a.aeo_score} is below the ${rule.auto_approve_min_aeo} this workspace requires` };
    }
  }
  return { approve: true };
}

export type AutoApproveResult = {
  articleId: string;
  workspaceId: string;
  outcome: "approved" | "held" | "error";
  detail?: string;
};

type WorkspaceRow = AutoApproveRule & { id: string; account_id: string; domain: string | null; status: string };

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
    .select("id, account_id, domain, status, auto_approve, auto_approve_hold_hours, auto_approve_min_seo, auto_approve_min_aeo, auto_approve_set_by")
    .eq("auto_approve", true)
    .eq("status", "on");
  if (wsError) throw new Error(`auto-approve: workspaces: ${wsError.message}`);

  for (const ws of (wsRows ?? []) as WorkspaceRow[]) {
    const { data: articles, error: artError } = await supabase
      .from("articles")
      .select("id, workspace_id, status, held_by, auto_approve_after, created_at, seo_score, aeo_score, content, research, keyword, title, slug, meta_description, featured_image_url, auto_approve_hold_reason")
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

    for (const article of articles as ArticleRow[]) {
      try {
        const html = article.content ? tiptapToHtml(article.content) : "";
        const report = html ? factCheckArticle(html, article.research ?? undefined) : null;
        if (report) {
          await supabase
            .from("articles")
            .update({ fact_checks: report, fact_check_verdict: report.verdict })
            .eq("id", article.id);
        }
        const audit = html
          ? auditArticle({
              html,
              keyword: article.keyword ?? "",
              siteDomain: ws.domain,
              title: article.title,
              metaDescription: article.meta_description,
              slug: article.slug,
              featuredImageUrl: article.featured_image_url,
            })
          : null;

        const decision = decideAutoApproval(
          ws,
          {
            ...article,
            factCheckBlocker: report ? approvalBlocker(report) : "draft has no content",
            auditFailures: audit ? audit.items.filter((i) => i.status === "fail").map((i) => i.label) : [],
            needsPlan,
            hasDestination,
            ruleOwnerIsMember,
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
          out.push({ articleId: article.id, workspaceId: ws.id, outcome: "held", detail: decision.reason });
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
