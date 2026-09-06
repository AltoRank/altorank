import { ImageResponse } from "next/og";
import { NextResponse, type NextRequest } from "next/server";
import { getShareCardFactsByToken } from "@/lib/queries/share";
import { buildShareCard, CARD_WIDTH, CARD_HEIGHT } from "@/lib/share/card";
import { isShareToken, publicShareCard } from "@/lib/share/token";
import { ShareCardView } from "@/components/share/card-view";

/**
 * The share card as a PNG, for a link that unfurls.
 *
 * Public: the token is the credential (lib/share/token.ts), the service role
 * does the read, and only `publicShareCard` - the numbers drawn on the
 * picture - reaches satori. Cached for an hour so a post that gets unfurled
 * by a thousand clients costs one render; a revoked token stops resolving
 * within that hour.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isShareToken(token)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const facts = await getShareCardFactsByToken(token);
  if (!facts) return NextResponse.json({ error: "not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });

  const card = publicShareCard(buildShareCard(facts));
  return new ImageResponse(<ShareCardView card={{ ...card, omitted: [] }} />, {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    headers: { "Cache-Control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
