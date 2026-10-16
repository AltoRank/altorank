import type { SupabaseClient } from "@supabase/supabase-js";
import { startRun, latestRun } from "@/lib/onboarding/run-store";
import { canSpend } from "@/lib/billing/spend-gate";
import { failedRunNotice, phaseLabel, PHASE_ORDER } from "@/lib/onboarding/events";

/**
 * The first look for a store that came from the Shopify App Store: the same
 * run /api/onboard/start begins for a signed-up site, started without a
 * session. The caller dispatches the worker with `after()`.
 */
export async function startShopFirstLook(
  db: SupabaseClient,
  site: { accountId: string; workspaceId: string },
): Promise<{ runId: string; created: boolean } | { refused: string }> {
  const started = await startRun(db, { id: site.workspaceId, account_id: site.accountId }, Date.now(), {
    mayCreate: async () => {
      const gate = await canSpend(db, site.accountId, { userEmail: null, workspaceId: site.workspaceId, action: "setup" });
      return gate.allowed ? null : gate.message;
    },
  });
  if (started.refused !== undefined) return { refused: started.refused };
  return { runId: started.runId, created: started.created };
}

export interface FirstLookView {
  state: "none" | "running" | "done" | "failed";
  message: string;
  /** 0-100 while running. */
  progress?: number;
}

/** What the embedded app shows about the first look, from the latest run. */
export async function firstLookView(db: SupabaseClient, workspaceId: string): Promise<FirstLookView> {
  const snapshot = await latestRun(db, workspaceId);
  const run = snapshot.run;
  if (!run) return { state: "none", message: "" };

  if (run.status === "running" && !snapshot.stale) {
    const finished = run.phases.filter((p) => p.status === "done" || p.status === "skipped").length;
    const active = run.phases.find((p) => p.status === "active");
    return {
      state: "running",
      message: active ? phaseLabel(active) : "Reading your store. This takes about a minute.",
      progress: (finished / PHASE_ORDER.length) * 100,
    };
  }

  const failed = failedRunNotice(snapshot);
  if (failed?.tone === "error") return { state: "failed", message: failed.line };
  return { state: "done", message: "" };
}
