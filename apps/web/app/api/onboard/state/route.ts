import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { latestRun } from "@/lib/onboarding/run-store";

// ---------------------------------------------------------------------------
// GET /api/onboard/state?workspaceId= — the latest onboarding run, for polling
// ---------------------------------------------------------------------------
//
// Cheap on purpose: one row, plus the draft's row when there is one. The
// screen asks every three seconds while a run is live (ten after two
// minutes), and folds the answer through `stateFromRun`, the counterpart of
// the reducer the worker wrote the row with. Read through the user's client,
// so the 076 policy - members of the workspace's agency, and only them - is
// what decides whether the row is visible at all.

export async function GET(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = request.nextUrl.searchParams.get("workspaceId");
  if (!workspaceId) return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });

  const { data: workspace } = await supabase.from("workspaces").select("id, agency_id").eq("id", workspaceId).maybeSingle();
  if (!workspace) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const { data: membership } = await supabase
    .from("agency_members")
    .select("id")
    .eq("agency_id", workspace.agency_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const now = Date.now();
  const snapshot = await latestRun(supabase, workspaceId, now);
  return NextResponse.json(
    { ...snapshot, now },
    { headers: { "Cache-Control": "no-store" } },
  );
}
