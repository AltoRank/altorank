// ---------------------------------------------------------------------------
// Finishing what a trial start began, when the function doing it was cut off
// ---------------------------------------------------------------------------
//
// The trial start's follow-up runs in serverless functions that the platform
// may stop at their time limit (lib/plan/resume-week.ts), in two places:
//
//   the resume   the month's top-up and the opening of the week, one
//                invocation per checkout. The webhook writes that the sites
//                are owed it before it answers Stripe, and the resume stamps
//                each site finished only when its work has run. A site still
//                owed with no live claim was never reached, or was cut off.
//   the chain    the week's drafts, each started by the one before it from
//                its `after()`. Owed entries with nobody writing any of them
//                are a chain that stopped.
//
// Both used to fail with no trace and leave the week to each entry's own
// date. The scheduled writer runs this at the top of every pass: it sends the
// unfinished resumes again and starts the stopped chains again, through the
// same self-invocation, so the week is picked up by the next run as a batch
// rather than one entry a day. Every claim below is the same conditional
// update the first attempt used, so a resume or a chain that is in fact still
// alive loses the race and does nothing twice.

import type { SupabaseClient } from "@supabase/supabase-js";
import { claimsInFlight } from "@/lib/plan/draft-claim";
import { RESUME_LEASE_MS, RESUME_SITE_COLUMNS, drainOwed, type ResumeSite, type WeekDeps } from "@/lib/plan/resume-week";
import { dispatchResume, type ResumeDispatchDeps } from "@/lib/plan/resume-dispatch";

/**
 * How long a stopped week is started again as a batch. The week a trial
 * opens is seven days at most; an entry still owed after that is an ordinary
 * past-dated entry, which the scheduled writer takes at the site's pace
 * (`duePlannedKeyword`) rather than as a burst weeks later - say, the day
 * somebody turns automatic drafting back on.
 */
export const OWED_RESTART_DAYS = 7;

export interface SweepDeps extends WeekDeps {
  dispatch?: (req: Parameters<typeof dispatchResume>[0], deps?: ResumeDispatchDeps) => Promise<void>;
}

export interface SweepOutcome {
  /** One line per thing started again, for the cron's report. */
  lines: string[];
  /** Settles once every draft request sent has answered. Never rejects. */
  settled: Promise<void>;
  /** Draft requests sent, so the caller knows whether there is anything to keep alive. */
  started: number;
}

/** Never throws: a sweep that fails is a line in the report, not a failed run. */
export async function sweepUnfinishedResumes(supabase: SupabaseClient, deps: SweepDeps = {}): Promise<SweepOutcome> {
  const now = deps.now ?? new Date();
  const lines: string[] = [];
  const pending: Promise<void>[] = [];
  let started = 0;
  const resent = new Set<string>();

  // The resumes. Owed, not finished, and nobody holding a live claim.
  try {
    const cutoff = new Date(now.getTime() - RESUME_LEASE_MS).toISOString();
    const { data, error } = await supabase
      .from("workspaces")
      .select("id, account_id, trial_resume_key")
      .not("trial_resume_key", "is", null)
      .is("trial_resumed_at", null)
      .or(`trial_resume_claimed_at.is.null,trial_resume_claimed_at.lt.${cutoff}`);
    if (error) throw new Error(error.message);
    const owed = new Map<string, { accountId: string; key: string }>();
    for (const row of (data ?? []) as Array<{ id: string; account_id: string; trial_resume_key: string | null }>) {
      if (!row.trial_resume_key) continue;
      owed.set(`${row.account_id}\u0000${row.trial_resume_key}`, { accountId: row.account_id, key: row.trial_resume_key });
      resent.add(row.id);
    }
    if (owed.size) {
      const accountIds = [...new Set([...owed.values()].map((o) => o.accountId))];
      const { data: accounts, error: accountsError } = await supabase.from("accounts").select("id, plan_status").in("id", accountIds);
      if (accountsError) throw new Error(accountsError.message);
      const status = new Map(((accounts ?? []) as Array<{ id: string; plan_status: string | null }>).map((a) => [a.id, a.plan_status]));
      for (const { accountId, key } of owed.values()) {
        // Whether the checkout started a trial, from the account row the
        // webhook wrote in the same handler that owed this (`plan_status:
        // trial ? "trialing" : "active"`). A trial that has since ended is no
        // longer the moment to burst a week, and gets the month only.
        const draftWeek = status.get(accountId) === "trialing";
        await (deps.dispatch ?? dispatchResume)({ accountId, key, draftWeek }, { ...deps, supabase });
        lines.push(`${accountId}: sent the checkout's follow-up again (${draftWeek ? "month and week" : "month"})`);
      }
    }
  } catch (err) {
    lines.push(`unfinished resumes could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The chains. Owed entries nobody has claimed, on a site with nothing in
  // flight. A site whose resume was just sent again is left to it.
  try {
    const since = new Date(now.getTime() - OWED_RESTART_DAYS * 86_400_000).toISOString();
    const { data, error } = await supabase
      .from("calendar_entries")
      .select("workspace_id")
      .eq("status", "queue")
      .is("article_id", null)
      .is("draft_claimed_at", null)
      .gte("draft_owed_at", since);
    if (error) throw new Error(error.message);
    const sites = [...new Set(((data ?? []) as Array<{ workspace_id: string }>).map((r) => r.workspace_id))].filter((id) => !resent.has(id));
    for (const workspaceId of sites) {
      try {
        if ((await claimsInFlight(supabase, workspaceId, now)) > 0) continue;
        const { data: site, error: siteError } = await supabase.from("workspaces").select(RESUME_SITE_COLUMNS).eq("id", workspaceId).maybeSingle();
        if (siteError) throw new Error(siteError.message);
        if (!site) continue;
        const step = await drainOwed(supabase, site as ResumeSite, { ...deps, now, by: `resume:${now.toISOString()}` });
        pending.push(step.settled);
        started += step.started.length;
        if (step.started.length) lines.push(`${workspaceId}: started the rest of the trial's week again, ${step.started.length} ${step.started.length === 1 ? "draft" : "drafts"}`);
      } catch (err) {
        lines.push(`${workspaceId}: the trial's week could not be started again: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    lines.push(`owed drafts could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { lines, settled: Promise.all(pending).then(() => undefined), started };
}
