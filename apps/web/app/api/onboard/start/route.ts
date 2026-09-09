import { NextRequest, NextResponse, after } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { startRun } from "@/lib/onboarding/run-store";
import { dispatchWorker } from "@/lib/onboarding/run-dispatch";

// ---------------------------------------------------------------------------
// POST /api/onboard/start — begin (or find) the onboarding run for a workspace
// ---------------------------------------------------------------------------
//
// Replaces /api/onboard/stream, which ran the whole pipeline inside the
// browser's request and stopped at the next phase boundary when that request
// went away - a reload, a closed tab, a same-tab navigation. This inserts an
// `onboarding_runs` row and returns its id at once; the work happens in
// /api/onboard/run, dispatched from after() so this response does not cancel
// it, and the screen polls GET /api/onboard/state for the row.
//
// Idempotent: a workspace with a run already `running` gets that run's id and
// no second worker (the partial unique index in 076 is what makes a race
// safe), so the screen may call this on every mount.

// The inline fallback runs the pipeline in after() when this install cannot
// self-invoke; give that path the budget the worker route has.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { workspaceId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const workspaceId = body.workspaceId;
  if (!workspaceId) return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });

  const { data: workspace } = await supabase.from("workspaces").select("id, account_id").eq("id", workspaceId).single();
  if (!workspace) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  // Membership, not just existence: RLS would hide a foreign workspace, but the
  // 404 above cannot tell "not yours" from "not there", and onboarding writes.
  const { data: membership } = await supabase
    .from("account_members")
    .select("id")
    .eq("account_id", workspace.account_id)
    .eq("user_id", user.id)
    .single();
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { runId, created } = await startRun(createServiceClient(), {
    id: workspace.id as string,
    account_id: workspace.account_id as string,
  });
  if (created) after(() => dispatchWorker(runId));

  return NextResponse.json({ runId, existing: !created });
}
