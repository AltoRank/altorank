import { NextRequest, NextResponse, after } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { authorised } from "@/lib/content/fan-out";
import { claimRun, runClaimed } from "@/lib/onboarding/run-worker";
import { failRun } from "@/lib/onboarding/run-store";

// ---------------------------------------------------------------------------
// POST /api/onboard/run — the onboarding worker
// ---------------------------------------------------------------------------
//
// Server-to-server only, authenticated with CRON_SECRET like the cron routes
// and /api/internal/draft: the caller is /api/onboard/start, which has no
// session to forward. Runs the phases with the service client and writes the
// row after every one (lib/onboarding/run-worker.ts). No request signal is
// read anywhere: nobody's tab is attached to this request, so nothing can
// cancel it but the platform's own ceiling.
//
// Claims the run, answers 202, and does the work in `after()` with this
// function's whole budget - the pattern /api/internal/resume-drafting uses.
// It used to answer when the pipeline was done, and the dispatcher awaited
// that answer: a first look takes 4.5-6.6 minutes on prod, and past 300 s
// Node's fetch gives up waiting for response headers (undici's default
// headersTimeout, on every Node deploy, self-hosted ones included). The
// dispatcher then stored "The run could not be started: fetch failed" and
// emailed that setup failed while this worker was still running; a local run
// on 2026-09-28 finished at 5:00 and was recorded as failed. Now the
// dispatcher waits for the claim, and how the run ends is written only by the
// worker (and the draft route it hands the draft to).

// Read, discover, plan: 4.5-6.6 minutes measured on prod, so the platform's
// ceiling, not this route's answer, is what bounds the work. A run cut off
// here stops writing and the reaper closes it on what it wrote.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  if (!authorised(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { runId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.runId) return NextResponse.json({ error: "runId is required" }, { status: 400 });

  const supabase = createServiceClient();
  const claim = await claimRun(supabase, body.runId);
  if (claim.outcome !== "claimed") {
    return NextResponse.json({ outcome: claim.outcome }, { status: claim.outcome === "not-found" ? 404 : 409 });
  }

  const runId = body.runId;
  after(async () => {
    try {
      const result = await runClaimed(claim.run, { supabase });
      // The draft request and the fan-out were fired, not awaited. Keep the
      // instance alive until they have answered so they are not frozen in
      // its socket buffer.
      await result.keepAlive;
    } catch (err) {
      // The pipeline's own failures are caught inside runClaimed; this is
      // anything around it. Closed on what the run wrote (`failRun`), so a
      // run that already has its plan or draft is not called a failure.
      await failRun(supabase, runId, err instanceof Error ? err.message : "Onboarding failed.");
    }
  });
  return NextResponse.json({ outcome: "accepted" }, { status: 202 });
}
