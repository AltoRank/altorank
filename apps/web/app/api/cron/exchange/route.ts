import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Daily cron: expire old exchange requests. (Expiry janitor only.)
 *
 * It deliberately does NOT auto-place links or auto-verify/auto-pay credits:
 * placing a link mutates a provider's published article content and must be an
 * explicit human action (placeExchange), and credit transfer must follow a real
 * verification (verifyExchange), not a timer.
 */
export async function GET(request: Request) {
  const cronSecret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createClient();
  const now = new Date().toISOString();

  // Expire old requests past their expiry date
  const { data: expired } = await supabase
    .from("backlink_exchanges")
    .update({ status: "expired" })
    .in("status", ["requested", "matched"])
    .lt("expires_at", now)
    .select("id");

  return NextResponse.json({
    success: true,
    expired: expired?.length ?? 0,
  });
}
