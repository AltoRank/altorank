import { after, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getRequestQuota } from "@/lib/queries/quota";
import { wakeFirstMonth } from "@/lib/onboarding/first-month";

export async function POST() {
  const { accountId, user } = await requireAuth(["owner", "admin", "editor"]);
  const workspaceId = await getScopedWorkspaceId();
  if (!workspaceId) return NextResponse.json({ error: "Workspace required" }, { status: 400 });
  const db = await createClient();
  const site = await db.from("workspaces").select("id, auto_generate, auto_generate_weekly_limit").eq("id", workspaceId).eq("account_id", accountId).maybeSingle();
  if (!site.data) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  const quota = await getRequestQuota(accountId, user.email ?? null);
  if (quota.reason !== "plan" || quota.remaining === 0 || !site.data.auto_generate || !site.data.auto_generate_weekly_limit) return NextResponse.json({ error: "Check your plan, allowance and writing pace" }, { status: 409 });
  const service = createServiceClient();
  // Retry only terminal runs; do not disturb an active writer or its lease.
  const reset = await service.rpc("retry_first_month", { p_workspace: workspaceId });
  if (reset.error) return NextResponse.json({ error: "Could not retry" }, { status: 500 });
  if (!reset.data) {
    const current = await db.from("first_month_runs").select("status").eq("workspace_id", workspaceId).maybeSingle();
    if (current.error) return NextResponse.json({ error: "Could not read preparation" }, { status: 500 });
    if (!["queued", "planning", "writing"].includes(current.data?.status ?? "")) return NextResponse.json({ error: "Preparation has finished or is not available to retry yet" }, { status: 409 });
    after(() => wakeFirstMonth(workspaceId));
    return NextResponse.json({ status: "already-running" }, { status: 202 });
  }
  after(() => wakeFirstMonth(workspaceId));
  return NextResponse.json({ status: "queued" }, { status: 202 });
}
