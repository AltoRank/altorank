import { NextRequest, NextResponse, after } from "next/server";
import { authorised } from "@/lib/content/fan-out";
import { executeRun } from "@/lib/onboarding/run-worker";

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

// Read, discover and schedule take tens of seconds; the draft is not written
// here (see the worker), so this finishes well inside the budget.
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

  const result = await executeRun(body.runId);
  // The draft request and the fan-out were fired, not awaited. Keep the
  // instance alive until they have answered so they are not frozen in its
  // socket buffer; the response itself goes out now.
  after(() => result.keepAlive);

  const status =
    result.outcome === "not-found" ? 404
    : result.outcome === "already-running" || result.outcome === "already-finished" ? 409
    : 200;
  return NextResponse.json({ outcome: result.outcome }, { status });
}
