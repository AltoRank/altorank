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
  /** `empty`: it finished and found nothing to plan; `message` says why and what to do. */
  state: "none" | "running" | "done" | "failed" | "empty";
  message: string;
  /** 0-100 while running. */
  progress?: number;
  /** The storefront answers with Shopify's password page, so nothing on it can be read. */
  storefrontLocked?: boolean;
}

/**
 * Whether a storefront is behind Shopify's password page: a store still being
 * built, and every development store - the kind App Store reviewers install
 * on. Its home page redirects to /password, so the first look reads nothing.
 */
export async function storefrontLocked(domain: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`https://${domain}/`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000) });
    const location = res.headers.get("location") ?? "";
    return res.status >= 300 && res.status < 400 && /\/password(\b|$|\?)/.test(location);
  } catch {
    return false;
  }
}

const LOCKED_MESSAGE =
  "Your storefront is password-protected, so AltoRank could not read it. Remove the password " +
  "(Online Store > Preferences > Password protection), then press Try again.";

/** What the embedded app shows about the first look, from the latest run. */
export async function firstLookView(
  db: SupabaseClient,
  workspaceId: string,
  opts: { domain?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<FirstLookView> {
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

  // Finished, but nothing came of it: say why rather than show an empty
  // queue. A locked storefront is the common cause on Shopify, and the one
  // the merchant can fix in a minute.
  const producedNothing = !run.article_id && (run.planned?.length ?? 0) === 0;
  if (producedNothing) {
    if (opts.domain && (await storefrontLocked(opts.domain, opts.fetchImpl))) {
      return { state: "empty", message: LOCKED_MESSAGE, storefrontLocked: true };
    }
    const why = run.phases.find((p) => p.status === "skipped" || p.status === "failed")?.detail;
    return {
      state: "empty",
      message: why ?? "The first look finished without anything to plan yet.",
    };
  }
  return { state: "done", message: "" };
}
