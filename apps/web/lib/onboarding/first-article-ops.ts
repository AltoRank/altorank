// ---------------------------------------------------------------------------
// A first look that planned topics and wrote no first article
// ---------------------------------------------------------------------------
//
// The first-article rule (lib/keyword-research/value-tiers.ts
// `chooseFirstArticle`) can decline every planned topic: none is about a
// service closely enough (value 2 or more) on an editorial results page.
// The run is then `partial` with a calendar, so neither the setup-failed
// email (the person has something to open) nor the nothing-planned one
// fires, and a warn event alone reached nobody. This tells the operators,
// through the nothing-planned email's path, that a person picks the first
// topic. Never throws: the run is already settled.

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordEvent } from "@/lib/observability/record";
import { notifyOperatorsNothingPlanned } from "@/lib/email/lifecycle";

export async function announceNoFirstArticle(
  supabase: SupabaseClient,
  runId: string,
  scope: { workspaceId: string; accountId: string | null; domain: string | null; preTrial: boolean },
  plannedTopics: number,
  why: string,
): Promise<void> {
  try {
    await recordEvent(
      {
        level: "warn",
        source: "onboarding.no_first_article",
        message: `A first look planned ${plannedTopics} topic${plannedTopics === 1 ? "" : "s"} and wrote no first article: ${why}`,
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        context: { runId, planned: plannedTopics },
      },
      supabase,
    );
    if (!scope.accountId) return;
    await notifyOperatorsNothingPlanned(
      supabase,
      { accountId: scope.accountId, workspaceId: scope.workspaceId },
      { runId, domain: scope.domain, pool: null, preTrial: scope.preTrial, plannedTopics },
    );
  } catch (err) {
    console.error(`[onboarding] run ${runId}: no-first-article operator email: ${err instanceof Error ? err.message : err}`);
  }
}
