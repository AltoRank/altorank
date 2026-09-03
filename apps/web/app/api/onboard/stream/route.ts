import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runOnboarding } from "@/lib/onboarding/pipeline";

// ---------------------------------------------------------------------------
// POST /api/onboard/stream — run onboarding, stream its progress over SSE
// ---------------------------------------------------------------------------
//
// Auth and transport only; the work is in lib/onboarding/pipeline so this route
// and the non-streaming action cannot drift. Each event the pipeline emits is
// forwarded verbatim as one SSE frame, and the client folds them with the same
// reducer the pipeline's own tests use.

// The pipeline crawls the site, calls DataForSEO, and writes a full article -
// the long pole is the same model call the generate cron gives 300s.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: { workspaceId?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const workspaceId = body.workspaceId;
  if (!workspaceId) return json({ error: "workspaceId is required" }, 400);

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, domain, agency_id, language")
    .eq("id", workspaceId)
    .single();
  if (!workspace) return json({ error: "Workspace not found" }, 404);

  // Membership, not just existence: RLS would hide a foreign workspace, but the
  // 404 above cannot tell "not yours" from "not there", and onboarding writes.
  const { data: membership } = await supabase
    .from("agency_members")
    .select("id")
    .eq("agency_id", workspace.agency_id)
    .eq("user_id", user.id)
    .single();
  if (!membership) return json({ error: "Forbidden" }, 403);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // A closed stream (the user navigated away, the tab died) makes enqueue
      // throw; swallow it so a disconnect does not surface as a phase failure.
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          /* client gone */
        }
      };

      try {
        await runOnboarding(supabase, workspace as never, send);
      } catch (err) {
        send({ phase: "error", detail: err instanceof Error ? err.message : "Onboarding failed" });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
