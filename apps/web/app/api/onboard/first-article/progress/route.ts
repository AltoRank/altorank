import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { readFirstArticleProgress } from "@/lib/onboarding/first-article-body";

// ---------------------------------------------------------------------------
// GET /api/onboard/first-article/progress?workspaceId=... — the gate's outline
// ---------------------------------------------------------------------------
//
// How far the owner's first article has got while its body is written: the
// stage, which of the outline's sections are written, and the words so far.
// No text, with PRETRIAL_FULL_ARTICLE on or off - the answer is built from a
// fixed set of counts below, so nothing else the read returns can ride along.
// Same owner and first-article checks as the reader
// (lib/onboarding/first-article-body.ts); a refusal is a 404 whatever its
// reason.

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspaceId = request.nextUrl.searchParams.get("workspaceId");
  if (!workspaceId) return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });
  const read = await readFirstArticleProgress(supabase, user.id, workspaceId);
  if (!read.ok) return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "cache-control": "no-store" } });
  return NextResponse.json(
    {
      articleId: read.articleId,
      done: read.done,
      stage: read.stage,
      stageMs: read.stageMs,
      sectionsDone: read.sectionsDone,
      sections: read.sections,
      words: read.words,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
