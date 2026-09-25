import { NextRequest, NextResponse, after } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { authorised } from "@/lib/content/fan-out";
import { resumeAccount } from "@/lib/plan/resume-week";

// ---------------------------------------------------------------------------
// POST /api/internal/resume-drafting — what a checkout opens, off the webhook
// ---------------------------------------------------------------------------
//
// Server-to-server only, authenticated with CRON_SECRET like the cron routes
// and /api/onboard/run: the caller is the Stripe webhook, which has answered
// Stripe already and has no session to forward. Tops up every site's month,
// and when the checkout started a trial, sends the rest of this week to
// /api/internal/draft one entry per request (lib/plan/resume-week.ts).
//
// Safe to call twice for one checkout: each site is claimed for `key` (the
// subscription) before anything is done, so the second call finds every site
// taken and does nothing. The report says which.

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

  const result = await resumeAccount(createServiceClient(), body.accountId, {
    key: body.key,
    draftWeek: body.draftWeek === true,
  });
  // The draft requests were sent, not awaited. Keep the instance alive until
  // they have left and answered, so they are not frozen in its socket buffer.
  after(() => result.settled);
  return NextResponse.json({ accountId: result.accountId, sites: result.sites });
}
