import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { readUnsubscribeParams } from "@/lib/email/unsubscribe";
import { unsubscribeAddress } from "@/lib/email/preferences";

/**
 * One-click unsubscribe (RFC 8058).
 *
 * Mail clients that show their own "unsubscribe" button POST here, with no
 * body and no session, using the URL from the `List-Unsubscribe` header. There
 * is no confirmation step by design: the RFC requires the POST alone to be
 * enough, and a client that had to render a page would show the button and
 * then fail.
 *
 * The three query parameters are the authorisation. `s` is an HMAC over the
 * address and the category (lib/email/unsubscribe.ts), so this cannot be used
 * to silence an address somebody merely guessed - which an unsigned endpoint
 * on a public route would be.
 *
 * Service role, because the person unsubscribing is by definition not signed
 * in. Nothing here reads or returns anything about the account; the only write
 * is one row keyed by the address already in the signed link.
 */
export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const parsed = readUnsubscribeParams(searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.reason }, { status: 400 });
  }

  try {
    await unsubscribeAddress(createServiceClient(), parsed.email, parsed.category);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not record that." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, email: parsed.email, category: parsed.category });
}
