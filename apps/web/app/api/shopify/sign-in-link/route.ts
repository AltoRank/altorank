import { NextResponse } from "next/server";
import { sendSignInCode } from "@/lib/email/auth-emails";
import { authenticateLinkedShop } from "@/lib/shopify/request-auth";
import { accountOwner } from "@/lib/shopify/owner";

/**
 * POST /api/shopify/sign-in-link - email the owner a one-time link into the
 * full dashboard. It goes to the owner's own address, never one the client
 * names, so the inbox is the proof; the link opens a top-level tab, where the
 * session cookie can be set (it cannot inside Shopify's iframe).
 */
export async function POST(request: Request) {
  const auth = await authenticateLinkedShop(request);
  if (!auth.ok) return auth.response;
  const owner = await accountOwner(auth.ctx.supabase, auth.ctx.installation.accountId);
  if (!owner?.email || owner.placeholder) {
    return NextResponse.json({ error: "This account has no email to send a link to." }, { status: 409 });
  }
  try {
    const { sent } = await sendSignInCode(owner.email, "/dashboard");
    if (!sent) return NextResponse.json({ error: "Could not find the account's login." }, { status: 409 });
  } catch {
    return NextResponse.json({ error: "Could not send the link. Try again in a minute." }, { status: 502 });
  }
  return NextResponse.json({ sentTo: owner.email });
}
