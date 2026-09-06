/**
 * Write exactly one draft, in its own invocation.
 *
 * Server-to-server only, authenticated with CRON_SECRET like the cron routes:
 * the caller is `fanOutDrafts`, dispatched from the onboarding stream, which
 * has no user session to forward. See lib/content/fan-out.ts for why this
 * exists at all - briefly, a draft costs 103s against a 300s function, so the
 * way to write seven quickly is seven invocations rather than one longer one.
 *
 * One draft per request, never a loop. That is the whole point: the budget is
 * per invocation, and a loop here would rebuild the bottleneck it removes.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { generateArticle } from "@/lib/content/generate";
import { fulfilPlannedEntry } from "@/lib/onboarding/plan";
import { getQuota } from "@/lib/billing/quota";
import { authorised } from "@/lib/content/fan-out";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { workspaceId?: string; keywordId?: string; keyword?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { workspaceId, keywordId, keyword } = body;
  if (!workspaceId || !keywordId || !keyword) {
    return NextResponse.json(
      { error: "workspaceId, keywordId and keyword are required" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, agency_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  // The same gate the cron and the onboarding pipeline use. Six requests go out
  // at once and each checks independently, so a burst cannot spend more than
  // the entitlement: the last ones to arrive find nothing remaining.
  const quota = await getQuota(supabase, workspace.agency_id as string);
  if (quota.limit !== null && (quota.remaining ?? 0) <= 0) {
    return NextResponse.json({ status: "skipped", reason: "quota" }, { status: 200 });
  }

  // Idempotence, and the reason it matters: a retried dispatch, or the cron
  // reaching the same entry first, must not produce a second article for one
  // planned day. An entry that already carries an article_id is done.
  const { data: entry } = await supabase
    .from("calendar_entries")
    .select("id, article_id")
    .eq("workspace_id", workspaceId)
    .eq("keyword_id", keywordId)
    .is("article_id", null)
    .maybeSingle();
  if (!entry) {
    return NextResponse.json({ status: "skipped", reason: "already-written" }, { status: 200 });
  }

  try {
    const result = await generateArticle({
      supabase,
      workspaceId,
      keyword,
      keywordId,
      autonomous: true,
      billToAgencyId: workspace.agency_id as string,
    });
    await fulfilPlannedEntry(supabase, entry.id as string, result.articleId);
    return NextResponse.json(
      { status: "generated", articleId: result.articleId, wordCount: result.wordCount },
      { status: 200 },
    );
  } catch (err) {
    return NextResponse.json(
      { status: "error", error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
