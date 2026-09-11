import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";

export async function GET(request: NextRequest) {
  let accountId: string;
  try { ({ accountId } = await requireAuth()); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  const id = request.nextUrl.searchParams.get("session_id");
  if (!id || !/^cs_[a-zA-Z0-9_]+$/.test(id)) return NextResponse.json({ error: "Invalid checkout session" }, { status: 400 });
  try {
    const session = await getStripe().checkout.sessions.retrieve(id);
    if (session.client_reference_id !== accountId) return NextResponse.json({ error: "Checkout not found" }, { status: 404 });
    const db = await createClient();
    const { data: account, error } = await db.from("accounts").select("stripe_subscription_id, plan_status, trial_ends_at").eq("id", accountId).single();
    if (error) throw error;
    const subscription = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    const entitled = account?.plan_status === "active" || (account?.plan_status === "trialing" && Date.parse(account.trial_ends_at ?? "") > Date.now());
    return NextResponse.json({ status: session.status, active: Boolean(session.status === "complete" && subscription && subscription === account?.stripe_subscription_id && entitled) }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "Activation could not be checked. Please retry." }, { status: 503 }); }
}
