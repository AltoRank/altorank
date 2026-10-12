import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { readFirstArticleBody } from "@/lib/onboarding/first-article-body";

// ---------------------------------------------------------------------------
// GET /api/onboard/first-article?workspaceId=... — the gate's reader
// ---------------------------------------------------------------------------
//
// The owner's own first article, in full, while PRETRIAL_FULL_ARTICLE is on;
// as it is being written, then as saved. Every check is in
// lib/onboarding/first-article-body.ts; this only says who is asking. A
// refusal is a 404 whatever its reason, so the route says nothing about
// articles the caller may not read.

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspaceId = request.nextUrl.searchParams.get("workspaceId");
  if (!workspaceId) return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });
  const body = await readFirstArticleBody(supabase, user.id, workspaceId);
  if (!body.ok) return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "cache-control": "no-store" } });
  const { progress } = body;
  return NextResponse.json(
    {
      articleId: body.articleId,
      html: body.html,
      done: body.done,
      // The same counts the progress route answers, so the reader asks once.
      progress: { stage: progress.stage, stageMs: progress.stageMs, sectionsDone: progress.sectionsDone, sections: progress.sections, words: progress.words },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
