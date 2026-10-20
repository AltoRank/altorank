import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { ownedCheckoutSession, recordOnboardingStep } from "@/lib/onboarding/step-events";
import { isClientStep } from "@/lib/onboarding/step-names";
import { ARTICLE_STEPS, CHECKOUT_STEPS, stepProps, uuidOrUndefined } from "@/lib/onboarding/step-props";
import { getImpersonation } from "@/lib/auth/impersonation";

// ---------------------------------------------------------------------------
// POST /api/onboard/step — the browser says which onboarding step it reached
// ---------------------------------------------------------------------------
//
// Signed in only, and only for a workspace the person can see (RLS answers
// that) in an account they are a member of. The workspace is the one named,
// or the one in scope when none is (the checkout pages have no workspace in
// their URL). An article step names its article instead, and the workspace
// is the article's, read through the person's own client. A checkout step
// may name its Stripe session, kept only when it is the account's own.
// Written with the service role, once per step per workspace
// (lib/onboarding/step-events.ts), with only the props on the step's lists
// (lib/onboarding/step-props.ts).
// Answers 204 whatever happens to the write: the caller does not wait for it
// and has nothing to do with an error.

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // An operator viewing as the account is not the customer reaching a step:
  // each step is kept once per site, so an operator's visit filled slots the
  // customer never reached (a site read that worked after theirs failed).
  // Nothing is written; the browser does not wait for this answer anyway.
  if (await getImpersonation().catch(() => null)) return new NextResponse(null, { status: 204 });

  let body: { step?: unknown; workspaceId?: unknown; ms?: unknown; count?: unknown; articleId?: unknown; checkoutSession?: unknown; props?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  // `run_started` is the server's own (lib/onboarding/step-names.ts).
  if (!isClientStep(body.step)) return NextResponse.json({ error: "Unknown step" }, { status: 400 });

  let articleId: string | undefined;
  let workspaceId: string | null;
  if (ARTICLE_STEPS.includes(body.step)) {
    articleId = uuidOrUndefined(body.articleId);
    if (!articleId) return NextResponse.json({ error: "articleId is required" }, { status: 400 });
    const { data: article } = await supabase.from("articles").select("id, workspace_id").eq("id", articleId).maybeSingle();
    if (!article) return NextResponse.json({ error: "Article not found" }, { status: 404 });
    workspaceId = article.workspace_id as string;
  } else {
    workspaceId = typeof body.workspaceId === "string" && body.workspaceId ? body.workspaceId : await getScopedWorkspaceId();
  }
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

  // The gate is shown only once a run has reached it: its time since signup
  // is the funnel's headline number, so a browser that says it earlier is
  // not believed. The run row is the server's (076: no client write).
  if (body.step === "gate_shown") {
    const { data: run } = await supabase
      .from("onboarding_runs")
      .select("status")
      .eq("workspace_id", workspace.id)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const status = (run as { status?: string } | null)?.status;
    if (!status || status === "running") return new NextResponse(null, { status: 204 });
  }

  // A checkout step keys on its Stripe session, so only the account's own
  // open session is kept; any other id is dropped and the step is kept
  // once per site and button, as if it had none.
  const service = createServiceClient();
  const checkoutSession = CHECKOUT_STEPS.includes(body.step) ? await ownedCheckoutSession(service, workspace.account_id as string, body.checkoutSession) : undefined;

  const signedUp = Date.parse(user.created_at ?? "");
  await recordOnboardingStep(service, {
    workspaceId: workspace.id as string,
    accountId: workspace.account_id as string,
    userId: user.id,
    step: body.step,
    ms: typeof body.ms === "number" ? body.ms : null,
    count: typeof body.count === "number" ? body.count : null,
    articleId: articleId ?? null,
    checkoutSession: checkoutSession ?? null,
    props: stepProps(body.step, body.props),
    secondsSinceSignup: body.step === "gate_shown" && Number.isFinite(signedUp) ? (Date.now() - signedUp) / 1000 : null,
  });
  return new NextResponse(null, { status: 204 });
}
