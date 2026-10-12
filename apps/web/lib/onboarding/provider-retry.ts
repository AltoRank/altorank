// ---------------------------------------------------------------------------
// A first look cut short by a provider outage, tried again overnight
// ---------------------------------------------------------------------------
//
// When the search-data provider (or the model judging its rows) did not
// answer, the setup screen used to say "Setup did not finish" and offer a
// free retry - which bought the same outage again, and again (UX audit
// 2026-10-12, #16). The screen now says the outage is ours, offers no retry
// button, and promises to try again; this is what keeps that promise.
//
// Once a night, from /api/cron/analyze, for a handful of sites: the site's
// LATEST run ended `partial` because a provider did not answer
// (`providerDown`), at least PROVIDER_RETRY_AFTER_MS ago and within
// PROVIDER_RETRY_WITHIN_MS; it has no article; its account is still before
// its trial; and the spend gate would start setup for it - the same
// question /api/onboard/start asks, which counts the account's pre-trial
// runs (PRE_TRIAL_SETUP_RUNS) and so bounds this to one retry. No spend
// loop: a retry that meets the same outage is the account's last pre-trial
// run, and the next night's gate refuses it.
//
// The person is told by the email every first article sends when it is
// written (lib/email/draft-batch.ts), or by the setup-failed email if the
// retry falls short too.

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordEvent } from "@/lib/observability/record";
import { providerDown, stateFromRun, type OnboardingRunRow } from "./events";
import { startRun } from "./run-store";
import { dispatchWorker } from "./run-dispatch";
import { providerRetryAllowed } from "./provider-retry-gate";
import { PROVIDER_RETRY_AFTER_MS, PROVIDER_RETRY_WITHIN_MS } from "./provider-retry-window";

export { providerRetryAllowed, PROVIDER_RETRY_AFTER_MS, PROVIDER_RETRY_WITHIN_MS };

/** Runs started per night: each buys a site read and keyword research. */
export const PROVIDER_RETRY_BATCH = 3;
/**
 * Finished runs read per page. `partial` runs that are not provider-down are
 * filtered out after the read (the cause is inside the phases), so the sweep
 * pages through the whole window rather than stopping at the first page: a
 * capped read let other partial runs push a provider-down run out of reach
 * while the screen promised it a retry (review, 2026-10-12).
 */
const PAGE = 50;
/** At most this many pages a night: 1,000 partial runs in three days is not a quiet night. */
const MAX_PAGES = 20;

export interface ProviderRetryDeps {
  allowed?: typeof providerRetryAllowed;
  start?: typeof startRun;
  dispatch?: (runId: string) => Promise<void>;
}

export type ProviderRetryOutcome = { workspaceId: string; runId?: string; skipped?: string };

export async function retryProviderDownRuns(
  supabase: SupabaseClient,
  now: number = Date.now(),
  deps: ProviderRetryDeps = {},
): Promise<ProviderRetryOutcome[]> {
  const allowed = deps.allowed ?? providerRetryAllowed;
  const start = deps.start ?? startRun;
  const dispatch = deps.dispatch ?? ((runId: string) => dispatchWorker(runId));
  type Row = OnboardingRunRow & { account_id: string };
  const candidates: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await supabase
      .from("onboarding_runs")
      .select("id, workspace_id, account_id, status, phases, planned, keywords_found, article_id, error, empty_pool, started_at, updated_at, finished_at")
      .eq("status", "partial")
      .lte("finished_at", new Date(now - PROVIDER_RETRY_AFTER_MS).toISOString())
      .gte("finished_at", new Date(now - PROVIDER_RETRY_WITHIN_MS).toISOString())
      .order("finished_at", { ascending: true })
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`provider retry: could not read finished runs (${error.message})`);
    const rows = (data ?? []) as Row[];
    // Filtered here, before anything counts against the night's batch.
    candidates.push(...rows.filter((row) => providerDown(stateFromRun(row, null))));
    if (rows.length < PAGE) break;
  }

  const out: ProviderRetryOutcome[] = [];
  let started = 0;
  for (const row of candidates) {
    if (started >= PROVIDER_RETRY_BATCH) break;
    const workspaceId = row.workspace_id;
    // Only the site's latest run: a later run, of any outcome, has answered.
    const { data: latest } = await supabase
      .from("onboarding_runs")
      .select("id")
      .eq("workspace_id", workspaceId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if ((latest as { id?: string } | null)?.id !== row.id) continue;
    const { count } = await supabase
      .from("articles")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .neq("status", "error");
    if ((count ?? 0) > 0) {
      out.push({ workspaceId, skipped: "has an article" });
      continue;
    }
    if (!(await allowed(supabase, row.account_id, workspaceId).catch(() => false))) {
      out.push({ workspaceId, skipped: "not allowed" });
      continue;
    }
    const res = await start(supabase, { id: workspaceId, account_id: row.account_id }, now, {
      mayCreate: async () => ((await allowed(supabase, row.account_id, workspaceId).catch(() => false)) ? null : "not allowed"),
    });
    if (res.refused !== undefined) {
      out.push({ workspaceId, skipped: res.refused });
      continue;
    }
    if (!res.created) {
      out.push({ workspaceId, skipped: "a run is already going" });
      continue;
    }
    started += 1;
    await dispatch(res.runId);
    await recordEvent(
      {
        level: "info",
        source: "onboarding.provider_retry",
        message: `A first look cut short by a provider outage was started again (run ${res.runId}, after ${row.id}).`,
        workspaceId,
        accountId: row.account_id,
        context: { runId: res.runId, previousRunId: row.id },
      },
      supabase,
    );
    out.push({ workspaceId, runId: res.runId });
  }
  return out;
}
