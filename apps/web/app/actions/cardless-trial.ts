"use server";

import { after } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { refusedWhileViewingAs } from "@/lib/auth/impersonation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getQuota } from "@/lib/billing/quota";
import { trialGateState } from "@/lib/billing/trial";
import { startCardlessTrial } from "@/lib/billing/cardless-trial";
import { dispatchResume } from "@/lib/plan/resume-dispatch";
import { recordTrialStarted } from "@/lib/onboarding/step-events";

export type FreeTrialStart = { ok: true } | { ok: false; error: string; needsCard?: true };

/**
 * The gate's button when the trial needs no card (lib/billing/cardless-trial.ts).
 * Owner only, as checkout is. On success the page is read again and opens on
 * the trial; the week's drafts start as they do after a checkout, up to the
 * trial's cap.
 */
export async function startFreeTrial(): Promise<FreeTrialStart> {
  const viewing = await refusedWhileViewingAs("Starting the trial");
  if (viewing) return { ok: false, error: viewing };
  const { accountId, user } = await requireAuth(["owner"]);
  const supabase = await createClient();

  // Only from the gate: an account that is past it already has its trial or plan.
  const quota = await getQuota(supabase, accountId, user.email ?? null);
  if (trialGateState(quota, user.email) === "open" && quota.reason === "plan") return { ok: true };

  const db = createServiceClient();
  const { data: sites, error } = await db.from("workspaces").select("id, domain").eq("account_id", accountId);
  if (error) return { ok: false, error: "The trial could not be started. Nothing was charged; try again." };
  const workspaces = (sites ?? []) as { id: string; domain: string | null }[];

  const started = await startCardlessTrial(db, {
    accountId,
    domains: workspaces.map((w) => w.domain).filter((d): d is string => Boolean(d)),
  });
  if (!started.ok) {
    if (started.reason === "site_trialed" || started.reason === "off") {
      return {
        ok: false,
        needsCard: true,
        error: "This site has had its free trial already, so this one starts with a card. Nothing is charged for 7 days.",
      };
    }
    if (started.reason === "not_eligible") return { ok: true };
    return { ok: false, error: "The trial could not be started. Nothing was charged; try again." };
  }

  const workspaceIds = workspaces.map((w) => w.id);
  after(() => recordTrialStarted(db, { accountId, workspaceIds, plan: "starter" }));
  after(() => dispatchResume({ accountId, key: `cardless:${accountId}`, draftWeek: true }));
  return { ok: true };
}
