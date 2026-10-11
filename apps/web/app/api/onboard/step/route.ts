import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { recordOnboardingStep } from "@/lib/onboarding/step-events";
import { isOnboardingStep } from "@/lib/onboarding/step-names";

// ---------------------------------------------------------------------------
// POST /api/onboard/step — the browser says which onboarding step it reached
// ---------------------------------------------------------------------------
//
// Signed in only, and only for a workspace the person can see (RLS answers
// that) in an account they are a member of. The workspace is the one named,
// or the one in scope when none is (the checkout pages have no workspace in
// their URL). Written with the service role, once per step per workspace
// (lib/onboarding/step-events.ts). Answers 204 whatever happens to the write:
// the caller does not wait for it and has nothing to do with an error.

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { step?: unknown; workspaceId?: unknown; ms?: unknown; count?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isOnboardingStep(body.step)) return NextResponse.json({ error: "Unknown step" }, { status: 400 });

  const workspaceId = typeof body.workspaceId === "string" && body.workspaceId ? body.workspaceId : await getScopedWorkspaceId();
  if (!workspaceId) return new NextResponse(null, { status: 204 });
  const { data: workspace } = await supabase.from("workspaces").select("id, account_id").eq("id", workspaceId).maybeSingle();
  if (!workspace) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  const { data: member } = await supabase
    .from("account_members")
    .select("id")
    .eq("account_id", workspace.account_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const signedUp = Date.parse(user.created_at ?? "");
  await recordOnboardingStep(createServiceClient(), {
    workspaceId: workspace.id as string,
    accountId: workspace.account_id as string,
    userId: user.id,
    step: body.step,
    ms: typeof body.ms === "number" ? body.ms : null,
    count: typeof body.count === "number" ? body.count : null,
    secondsSinceSignup: body.step === "gate_shown" && Number.isFinite(signedUp) ? (Date.now() - signedUp) / 1000 : null,
  });
  return new NextResponse(null, { status: 204 });
}
