// ---------------------------------------------------------------------------
// Getting the checkout's follow-up work out of the Stripe webhook
// ---------------------------------------------------------------------------
//
// The webhook calls this from `after()`: Stripe already has its 200, and this
// hands the month's top-up and the rest of the week to
// /api/internal/resume-drafting in its own invocation - the same
// self-invocation, with CRON_SECRET, that /api/onboard/start uses to hand a
// first look to /api/onboard/run (lib/onboarding/run-dispatch.ts). An install
// that cannot call itself runs the resume right here instead, still inside
// after(): the month is topped up within this function's budget, and the week
// is left to the scheduled writer, because its drafts need self-invocation
// too (lib/plan/resume-week.ts says so in its report).
//
// Never throws. A resume that could not start is recorded where an operator
// looks (`system_events`), and nothing is lost by it: the nightly top-up fills
// the month and cron/generate writes the week at its pace.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { selfInvocation, selfInvoke, type SelfInvokeDeps } from "@/lib/content/fan-out";
import { recordEvent } from "@/lib/observability/record";
import { resumeAccount } from "./resume-week";

export interface ResumeRequest {
  accountId: string;
  /** The checkout's subscription id: what each site is claimed for, once. */
  key: string;
  /** True when the checkout started a trial, which is when the hold lifts. */
  draftWeek: boolean;
}

export interface ResumeDispatchDeps extends SelfInvokeDeps {
  supabase?: SupabaseClient;
  resume?: typeof resumeAccount;
}

export async function dispatchResume(req: ResumeRequest, deps: ResumeDispatchDeps = {}): Promise<void> {
  const supabase = () => deps.supabase ?? createServiceClient();
  const how = selfInvocation(deps);
  try {
    if ("skipped" in how) {
      const result = await (deps.resume ?? resumeAccount)(supabase(), req.accountId, { key: req.key, draftWeek: req.draftWeek });
      await result.settled;
      return;
    }
    const res = await selfInvoke("/api/internal/resume-drafting", req, how);
    if (!res.ok) throw new Error(`the resume route answered ${res.status}`);
  } catch (err) {
    await recordEvent(
      {
        level: "warn",
        source: "plan.resume",
        message: `What the checkout opens could not be started: ${err instanceof Error ? err.message : String(err)}. The nightly top-up and the scheduled writer cover it.`,
        accountId: req.accountId,
        context: { key: req.key, draftWeek: req.draftWeek },
      },
      supabase(),
    );
  }
}
