import { NextRequest, NextResponse, after } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { authorised } from "@/lib/content/fan-out";
import { resumeAccount } from "@/lib/plan/resume-week";
import { recordEvent } from "@/lib/observability/record";

// ---------------------------------------------------------------------------
// POST /api/internal/resume-drafting — what a checkout opens, off the webhook
// ---------------------------------------------------------------------------
//
// Server-to-server only, authenticated with CRON_SECRET like the cron routes
// and /api/onboard/run: the callers are the Stripe webhook, which has answered
// Stripe already and has no session to forward, and the scheduled writer
// sending an unfinished one again (lib/plan/resume-sweep.ts). Tops up every
// owed site's month, and when the checkout started a trial, sends the rest of
// this week to /api/internal/draft one entry per request
// (lib/plan/resume-week.ts).
//
// Answers 202 at once and does the work in `after()`, with this function's
// whole budget. The caller only needs to know the request arrived: until
// this, the webhook waited here for minutes of top-up from inside its own
// `after()`, which has less of its budget left than this route has, so it was
// cut off first and a resume that failed left no trace. The outcome is now
// written from here, per site, where it is known.
//
// Safe to call twice for one checkout: each site is claimed for `key` (the
// subscription) before anything is done, so a second call finds every site
// taken or finished and does nothing.

// The top-up buys verdicts for the month (lib/keyword-research/queue.ts); the
// drafts themselves run in their own invocations.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  if (!authorised(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { accountId?: unknown; key?: unknown; draftWeek?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.accountId !== "string" || !body.accountId || typeof body.key !== "string" || !body.key) {
    return NextResponse.json({ error: "accountId and key are required" }, { status: 400 });
  }

  const accountId = body.accountId;
  const opts = { key: body.key, draftWeek: body.draftWeek === true };
  after(async () => {
    const supabase = createServiceClient();
    try {
      const result = await resumeAccount(supabase, accountId, opts);
      // The draft requests were sent, not awaited. Keep the instance alive
      // until they have left and answered, so they are not frozen in its
      // socket buffer.
      await result.settled;
    } catch (err) {
      // The sites stay owed, and the scheduled writer's next run sends this
      // again (lib/plan/resume-sweep.ts).
      await recordEvent(
        {
          level: "warn",
          source: "plan.resume",
          message: `What the checkout opens could not run: ${err instanceof Error ? err.message : String(err)}. The scheduled writer's next run sends it again.`,
          accountId,
          context: opts,
        },
        supabase,
      );
    }
  });
  return NextResponse.json({ accepted: true, accountId }, { status: 202 });
}
