import { NextRequest, NextResponse, after } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { startRun } from "@/lib/onboarding/run-store";
import { dispatchWorker } from "@/lib/onboarding/run-dispatch";
import { canSpend } from "@/lib/billing/spend-gate";

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
//
// A NEW run asks the spend gate first. It buys the site read and the keyword
// research again (about $0.22), and the only rule against running it twice
// was the wizard's: the gate screen stopped offering "Try again" once the
// first article existed (lib/onboarding/setup-retry.ts), while this route
// started a run for any member who POSTed. For an account that has not
// started its trial the gate answers no once setup has attempted its article,
// or once the account has started PRE_TRIAL_SETUP_RUNS runs - a setup that
// ended with no article to attempt could otherwise be bought again each time
// it finished (lib/billing/spend-gate.ts). The refusal's sentence is what the
// run screen shows.

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

  const accountId = workspace.account_id as string;
  const started = await startRun(
    createServiceClient(),
    { id: workspace.id as string, account_id: accountId },
    Date.now(),
    {
      mayCreate: async () => {
        const gate = await canSpend(supabase, accountId, {
          userEmail: user.email ?? undefined,
          workspaceId: workspace.id as string,
          action: "setup",
        });
        return gate.allowed ? null : gate.message;
      },
    },
  );
  if (started.refused !== undefined) {
    return NextResponse.json({ error: started.refused }, { status: 402 });
  }
  const { runId, created } = started;
  if (created) after(() => dispatchWorker(runId));

  return NextResponse.json({ runId, existing: !created });
}
