import { NextRequest, NextResponse, after } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { authorised } from "@/lib/content/fan-out";
import { recordEvent } from "@/lib/observability/record";
import { isAdminEmail } from "@/lib/auth/operators";
import { regenerateDraft } from "@/lib/content/regenerate-draft";

// ---------------------------------------------------------------------------
// POST /api/internal/regenerate — an operator rewrites one draft in place
// ---------------------------------------------------------------------------
//
// Server-to-server only, authenticated with CRON_SECRET like the other
// internal routes: the caller is the admin Drafts tab's server action
// (app/actions/admin-regenerate.ts), which has checked the operator and hands
// over their email. A draft is ~100s, longer than a server action should
// hold a request, so the work runs here in `after()` with this function's
// whole budget, and the action only waits for the 202.
//
// The rules live in lib/content/regenerate-draft.ts; this route is the door.

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  if (!authorised(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { articleId?: unknown; operatorEmail?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const articleId = typeof body.articleId === "string" ? body.articleId : "";
  const operatorEmail = typeof body.operatorEmail === "string" ? body.operatorEmail : "";
  if (!articleId) return NextResponse.json({ error: "articleId is required" }, { status: 400 });
  // The secret proves the caller is ours; the email is what the quota bypass
  // keys on, so it must be an operator's, not merely present.
  if (!isAdminEmail(operatorEmail)) return NextResponse.json({ error: "operatorEmail must be an operator" }, { status: 403 });

  after(async () => {
    const supabase = createServiceClient();
    try {
      await regenerateDraft(supabase, articleId, operatorEmail);
    } catch (err) {
      await recordEvent(
        {
          level: "warn",
          source: "admin.regenerate",
          message: `Regenerating draft ${articleId} failed: ${err instanceof Error ? err.message : String(err)}`,
          context: { articleId, operator: operatorEmail },
        },
        supabase,
      );
    }
  });
  return NextResponse.json({ accepted: true, articleId }, { status: 202 });
}
