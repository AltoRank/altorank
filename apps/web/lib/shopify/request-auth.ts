import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { shopifyAppCredentials, type ShopifyAppCredentials } from "./env";
import { bearerToken, verifyShopifyIdToken, ShopifyIdTokenError } from "./session-token";

/**
 * Who is asking, for every /api/shopify/* call from the embedded app.
 *
 * The iframe carries no AltoRank session, so the verified ID token is the
 * whole of it: it names the store, the store names its installation, and the
 * installation names the one account and site this request may touch. Every
 * query after this runs on the service role, so it must filter by the
 * `accountId` / `workspaceId` returned here and by nothing the client sent.
 */
export interface ShopifyRequestContext {
  app: ShopifyAppCredentials;
  shop: string;
  idToken: string;
  supabase: SupabaseClient;
  installation: {
    id: string;
    accountId: string | null;
    workspaceId: string | null;
    shopName: string | null;
  } | null;
}

export type ShopifyAuthResult = { ok: true; ctx: ShopifyRequestContext } | { ok: false; response: NextResponse };

/** A 401 that makes App Bridge fetch a fresh ID token and retry once. */
export function retryWithFreshToken(): NextResponse {
  return NextResponse.json(
    { error: "Shopify session expired" },
    { status: 401, headers: { "X-Shopify-Retry-Invalid-Session-Request": "1" } },
  );
}

export async function authenticateShopifyRequest(request: Request): Promise<ShopifyAuthResult> {
  const app = shopifyAppCredentials();
  if (!app) {
    return { ok: false, response: NextResponse.json({ error: "The Shopify app is not configured." }, { status: 503 }) };
  }
  const idToken = bearerToken(request);
  if (!idToken) return { ok: false, response: retryWithFreshToken() };

  let shop: string;
  try {
    shop = verifyShopifyIdToken(idToken, app).shop;
  } catch (err) {
    if (err instanceof ShopifyIdTokenError) return { ok: false, response: retryWithFreshToken() };
    throw err;
  }

  const supabase = createServiceClient();
  const { data } = await supabase
    .from("shopify_installations")
    .select("id, account_id, workspace_id, shop_name, uninstalled_at")
    .eq("shop_domain", shop)
    .maybeSingle();

  const installation =
    data && !data.uninstalled_at
      ? {
          id: data.id as string,
          accountId: (data.account_id as string | null) ?? null,
          workspaceId: (data.workspace_id as string | null) ?? null,
          shopName: (data.shop_name as string | null) ?? null,
        }
      : null;

  return { ok: true, ctx: { app, shop, idToken, supabase, installation } };
}

/** As above, for routes that only make sense once the store is set up. */
export async function authenticateLinkedShop(request: Request): Promise<
  | { ok: true; ctx: ShopifyRequestContext & { installation: { id: string; accountId: string; workspaceId: string; shopName: string | null } } }
  | { ok: false; response: NextResponse }
> {
  const auth = await authenticateShopifyRequest(request);
  if (!auth.ok) return auth;
  const inst = auth.ctx.installation;
  if (!inst || !inst.accountId || !inst.workspaceId) {
    return {
      ok: false,
      response: NextResponse.json({ error: "This store is not set up yet. Reload the app." }, { status: 409 }),
    };
  }
  return { ok: true, ctx: { ...auth.ctx, installation: { ...inst, accountId: inst.accountId, workspaceId: inst.workspaceId } } };
}
