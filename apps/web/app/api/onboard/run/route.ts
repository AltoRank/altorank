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
// row as progress changes (lib/onboarding/run-worker.ts). Research and
// database transport use invocation deadlines independent of the user's tab.

// Stop research at 240s and database transport at 285s, reserving time to
// persist the source-check queue before the platform ceiling.
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
    result.outcome === "retryable-error" ? 503
    : result.outcome === "not-found" ? 404
    : result.outcome === "already-running" || result.outcome === "already-finished" ? 409
    : 200;
  return NextResponse.json({ outcome: result.outcome }, {
    status,
    ...(status === 503 ? { headers: { "Retry-After": "5" } } : {}),
  });
}
