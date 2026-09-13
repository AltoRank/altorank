import { NextRequest, NextResponse, after } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { dispatchFirstDraft, canSelfInvoke } from "@/lib/content/fan-out";
import { generateArticle } from "@/lib/content/generate";
import { fulfilPlannedEntry } from "@/lib/onboarding/plan";
import { stampRun } from "@/lib/onboarding/run-store";
import { trainVoiceProfile } from "@/lib/voice/train";
import { readSiteText } from "@/lib/onboarding/site-text";
import { finishDeferredAudit } from "@/lib/onboarding/deferred-audit";
import { detectLinks } from "@/lib/linking/detect";
import type { OnboardingPlanned, OnboardingStep } from "@/lib/onboarding/events";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { workspaceId?: string; runId?: string; keywordId?: string; refine?: boolean };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid request" }, { status: 400 }); }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const workspaceId = await getScopedWorkspaceId();
  if (!workspaceId || workspaceId !== body.workspaceId || !body.runId) return NextResponse.json({ error: "Select the workspace before choosing a topic." }, { status: 400 });
  const { data: workspace } = await client.from("workspaces").select("id, domain, account_id").eq("id", workspaceId).maybeSingle();
  const { data: run } = await client.from("onboarding_runs").select("id, status, planned, phases").eq("id", body.runId).eq("workspace_id", workspaceId).maybeSingle();
  if (!workspace || !run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (run.status !== "awaiting_choice") return NextResponse.json({ error: "This run has already advanced. Reload to see its progress." }, { status: 409 });
  const db = createServiceClient();
  if (body.refine === true) {
    const { data, error } = await db.from("onboarding_runs").update({ status: "partial", finished_at: null, updated_at: new Date().toISOString() }).eq("id", run.id).eq("workspace_id", workspaceId).eq("status", "awaiting_choice").select("id");
    if (error || !data?.length) return NextResponse.json({ error: "The run changed. Reload before editing." }, { status: 409 });
    return NextResponse.json({ refined: true });
  }
  const topic = ((run.planned ?? []) as OnboardingPlanned[]).find((p) => p.keywordId === body.keywordId && p.brief?.status === "qualified");
  if (!topic?.keywordId) return NextResponse.json({ error: "Choose one of this run’s supported topics." }, { status: 400 });
  const phases = ((run.phases ?? []) as OnboardingStep[]).filter((p) => p.phase !== "drafting");
  phases.push({ phase: "drafting", status: "active", detail: `Preparing your chosen article: ${topic.brief?.angle ?? topic.term}` });
  const { data: claimed, error } = await db.from("onboarding_runs").update({ status: "running", phases, updated_at: new Date().toISOString() }).eq("id", run.id).eq("workspace_id", workspaceId).eq("status", "awaiting_choice").select("id");
  if (error || !claimed?.length) return NextResponse.json({ error: "Your choice is already being processed. Reload to see it." }, { status: 409 });
  after(async () => {
    const audit = workspace.domain ? finishDeferredAudit(db, workspaceId, workspace.domain).catch(() => console.warn("[onboarding] Deferred audit unavailable")) : Promise.resolve();
    try {
      // Voice and link discovery now happen only for the topic the user wants.
      await Promise.allSettled([
        workspace.domain ? readSiteText(workspace.domain).then((read) => read.text.length >= 250 ? trainVoiceProfile(db, workspaceId, read.text) : undefined) : Promise.resolve(),
        detectLinks(db, workspaceId),
      ]);
      if (canSelfInvoke()) {
        const sent = dispatchFirstDraft({ workspaceId, runId: run.id, keyword: topic.term, keywordId: topic.keywordId!, selection: { reasons: [topic.brief!.reason], score: 0, difficulty: null, volume: topic.brief?.demand?.volume ?? null } });
        if ("skipped" in sent) throw new Error("The draft could not be dispatched.");
        const response = await sent.request;
        if (!response.ok) throw new Error("The draft could not be started. Retry from your saved plan.");
        const outcome = await response.json();
        if (outcome.status !== "generated") throw new Error("The draft was not generated. Check your available draft allowance before retrying.");
      } else {
        const draft = await generateArticle({ supabase: db, workspaceId, keyword: topic.term, keywordId: topic.keywordId, autonomous: true });
        const { data: entry } = await db.from("calendar_entries").select("id").eq("workspace_id", workspaceId).eq("keyword_id", topic.keywordId).is("article_id", null).maybeSingle();
        if (entry) await fulfilPlannedEntry(db, entry.id, draft.articleId);
        await stampRun(db, run.id, { phase: "drafting", status: "done", detail: `Wrote ${draft.wordCount} words for your review.` }, { finish: true, article: { id: draft.articleId, title: draft.title, keyword: topic.term, wordCount: draft.wordCount, verdict: draft.factCheck.verdict } });
      }
      await db.from("workspaces").update({ onboarded_at: new Date().toISOString(), status: "on", auto_generate: true }).eq("id", workspaceId);
    } catch (error) {
      await stampRun(db, run.id, { phase: "drafting", status: "failed", detail: error instanceof Error ? error.message : "The chosen draft could not finish. Your topics are saved." }, { finish: true });
    } finally { await audit; }
  });
  return NextResponse.json({ runId: run.id });
}
