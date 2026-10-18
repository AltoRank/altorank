import { NextResponse, after } from "next/server";
import { authenticateLinkedShop } from "@/lib/shopify/request-auth";
import { startShopFirstLook } from "@/lib/shopify/first-look";
import { dispatchWorker } from "@/lib/onboarding/run-dispatch";

export const maxDuration = 300;

/**
 * POST /api/shopify/first-look - "Try again" on a first look that stopped.
 * Bounded by the same spend gate as a dashboard retry (PRE_TRIAL_SETUP_RUNS).
 */
export async function POST(request: Request) {
  const auth = await authenticateLinkedShop(request);
  if (!auth.ok) return auth.response;
  const { supabase, installation } = auth.ctx;
  const started = await startShopFirstLook(supabase, {
    accountId: installation.accountId,
    workspaceId: installation.workspaceId,
  });
  if ("refused" in started) return NextResponse.json({ error: started.refused }, { status: 402 });
  if (started.created) {
    const runId = started.runId;
    after(() => dispatchWorker(runId));
  }
  return NextResponse.json({ runId: started.runId });
}
