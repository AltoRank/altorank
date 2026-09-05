import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { writePlannedEntryNow } from "@/lib/plan/write-now";

// ---------------------------------------------------------------------------
// POST /api/plan/write-now — write a planned keyword's article now
// ---------------------------------------------------------------------------
//
// Auth and transport only; the behaviour is lib/plan/write-now. The planner
// card calls this rather than the `writeNow` server action because a server
// action that runs for minutes holds the router's action queue, and with it
// the `router.refresh()` the card polls progress with. A fetch does not.
//
// Runs to completion and answers once. The draft lands in review, never
// anywhere else.

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { entryId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.entryId !== "string" || !body.entryId) {
    return NextResponse.json({ error: "entryId is required" }, { status: 400 });
  }

  const workspaceId = await getScopedWorkspaceId();
  if (!workspaceId) return NextResponse.json({ error: "No workspace is selected." }, { status: 400 });

  try {
    const result = await writePlannedEntryNow(supabase, workspaceId, body.entryId, auth.user.email ?? undefined);
    revalidatePath("/content");
    revalidatePath("/dashboard");
    revalidatePath("/articles");
    return NextResponse.json(result);
  } catch (err) {
    // The refusals are the person's to read: quota, already written, already
    // being written. 409 rather than 500, since nothing broke.
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not write this article." }, { status: 409 });
  }
}
