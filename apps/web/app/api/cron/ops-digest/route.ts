import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { sendOperatorDigest } from "@/lib/observability/digest";

/**
 * Daily: what went wrong yesterday, to whoever ADMIN_EMAILS names. Unset
 * means nobody, and nobody means no email (lib/auth/operators.ts).
 *
 * Not wrapped in `observedCron`, on purpose. This is the one job whose output
 * is the log itself, and a run that recorded "ran clean" every morning would
 * put a row in the table it is meant to be summarising — and, on a quiet day,
 * be the only thing in it.
 *
 * A no-op is a 200 that says why (`sent: false, reason`), never an error: an
 * install with no operator address — which is every install that has not set
 * ADMIN_EMAILS, production included — or no mail provider is a supported
 * configuration and must not have a cron that fails every morning.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await sendOperatorDigest(createServiceClient()));
  } catch (err) {
    // `sendOperatorDigest` is written not to throw; if it ever does, the
    // digest is the last thing that should take a deployment's cron budget
    // down with it.
    return NextResponse.json({
      sent: false,
      reason: `the digest could not be built: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
