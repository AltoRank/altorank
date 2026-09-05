import { ImageResponse } from "next/og";
import { NextResponse, type NextRequest } from "next/server";
import { getShareCardFacts } from "@/lib/queries/share";
import { buildShareCard, CARD_WIDTH, CARD_HEIGHT } from "@/lib/share/card";
import { ShareCardView } from "@/components/share/card-view";

/**
 * The share card as a PNG, for a link that unfurls.
 *
 * Reads through the caller's cookie client, so RLS decides whether this
 * workspace is theirs: a foreign id is a 404, not a card. The picture is the
 * same `ShareCardView` the dialog rasterises, fed to satori.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const facts = await getShareCardFacts(id);
  if (!facts) return NextResponse.json({ error: "not found" }, { status: 404 });

  const card = buildShareCard(facts);
  return new ImageResponse(<ShareCardView card={card} />, {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    headers: { "Cache-Control": "private, no-store" },
  });
}
