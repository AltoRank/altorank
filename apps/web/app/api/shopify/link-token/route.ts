import { NextResponse } from "next/server";
import { appUrl } from "@/lib/app-url";
import { authenticateLinkedShop } from "@/lib/shopify/request-auth";
import { signLinkToken } from "@/lib/shopify/link";

/**
 * POST /api/shopify/link-token - from inside Shopify, a one-time link that
 * moves this store onto an AltoRank account the person already has. The link
 * opens at the top level, where they sign in (lib/shopify/link.ts).
 */
export async function POST(request: Request) {
  const auth = await authenticateLinkedShop(request);
  if (!auth.ok) return auth.response;
  const { shop, installation } = auth.ctx;
  const token = signLinkToken({ installationId: installation.id, shop, fromAccountId: installation.accountId });
  if (!token) return NextResponse.json({ error: "Linking is not set up on this server." }, { status: 503 });
  const url = new URL("/connect/shopify", appUrl());
  url.searchParams.set("token", token);
  return NextResponse.json({ url: url.toString() });
}
