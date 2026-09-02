import { NextResponse } from "next/server";
import { cronSecretFrom } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Daily cron: expire old exchange requests. (Expiry janitor only.)
 *
 * It deliberately does NOT auto-place links or auto-verify/auto-pay credits:
 * placing a link mutates a provider's published article content and must be an
 * explicit human action (placeExchange), and credit transfer must follow a real
 * verification (verifyExchange), not a timer.
 */
export async function GET(request: Request) {
  const cronSecret = cronSecretFrom(request);
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  /**
 * Cron requests carry no cookies, so the cookie-bound client authenticates as
 * nobody and RLS answers every query with an empty set. That is not an error,
 * so this route reported `success` with a zero count and had never processed a
 * single row. A cron has no user by definition: it must hold the service role.
 */
  const supabase = createServiceClient();
  const now = new Date().toISOString();

  // Expire old requests past their expiry date
  const { data: expired, error } = await supabase
    .from("backlink_exchanges")
    .update({ status: "expired" })
    .in("status", ["requested", "matched"])
    .lt("expires_at", now)
    .select("id");

  // `expired: 0` has to mean "nothing was due", never "the update never ran".
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    expired: expired?.length ?? 0,
  });
}
