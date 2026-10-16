import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt, encrypt } from "@/lib/crypto";
import { requireShopifyAppCredentials } from "./env";
import { refreshAccessToken, ShopifyRefreshRevokedError, type ShopifyTokenSet } from "./tokens";

/**
 * Stored App Store installations and the access token each one publishes
 * with. Service role only: the table has RLS on and no policies (110).
 *
 * The access token lives an hour and the refresh token is replaced on every
 * refresh, so the token is fetched here at the moment of use rather than
 * copied into workspace_integrations.config. Two publishers that find the
 * same store's token expired must not both refresh it - Shopify retires
 * whichever new pair is used second - so a refresh first takes a short lease
 * on the row (`refreshing_until`), and a caller that loses the race waits
 * for the winner's token instead of asking Shopify itself.
 */

/** The store uninstalled the app; there is nothing to publish with. */
export class ShopifyNotInstalledError extends Error {
  constructor(shop: string) {
    super(`AltoRank is not installed on ${shop} any more. Reinstall it from the Shopify App Store to publish there.`);
    this.name = "ShopifyNotInstalledError";
  }
}

/** Shopify refused the refresh token: the merchant has to open the app once. */
export class ShopifyReauthRequiredError extends Error {
  constructor(shop: string) {
    super(`Shopify needs ${shop} to reconnect. Open AltoRank from your Shopify admin (Apps → AltoRank) once and publishing resumes.`);
    this.name = "ShopifyReauthRequiredError";
  }
}

/** Refresh this long before Shopify's stated expiry. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** How long a refresh may hold the row before another caller may take over. */
const LEASE_MS = 30 * 1000;
const WAIT_STEP_MS = 500;
const WAIT_STEPS = 30;

interface InstallationRow {
  id: string;
  shop_domain: string;
  access_token: string | null;
  access_expires_at: string | null;
  refresh_token: string | null;
  needs_reauth_at: string | null;
  uninstalled_at: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Record a fresh token pair for a store, creating its row on first install.
 * Clears every "can't publish" mark: a successful exchange is proof the app
 * is installed and the merchant is present.
 */
export async function saveInstallationTokens(
  client: SupabaseClient,
  shop: string,
  tokens: ShopifyTokenSet,
): Promise<{ id: string }> {
  const { data, error } = await client
    .from("shopify_installations")
    .upsert(
      {
        shop_domain: shop,
        access_token: encrypt(tokens.accessToken),
        access_expires_at: new Date(tokens.accessExpiresAt).toISOString(),
        refresh_token: encrypt(tokens.refreshToken),
        refresh_expires_at: new Date(tokens.refreshExpiresAt).toISOString(),
        scopes: tokens.scopes,
        refreshing_until: null,
        needs_reauth_at: null,
        uninstalled_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "shop_domain" },
    )
    .select("id")
    .single();
  if (error || !data) throw new Error(`Could not save the Shopify installation: ${error?.message ?? "no row"}`);
  return { id: data.id as string };
}

async function readInstallation(client: SupabaseClient, installationId: string): Promise<InstallationRow> {
  const { data, error } = await client
    .from("shopify_installations")
    .select("id, shop_domain, access_token, access_expires_at, refresh_token, needs_reauth_at, uninstalled_at")
    .eq("id", installationId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the Shopify installation: ${error.message}`);
  if (!data) throw new Error("This Shopify connection's installation no longer exists. Reinstall the app.");
  return data as InstallationRow;
}

function usableToken(row: InstallationRow, rejectToken: string | null, now: number): string | null {
  if (!row.access_token || !row.access_expires_at) return null;
  if (Date.parse(row.access_expires_at) - REFRESH_MARGIN_MS <= now) return null;
  const token = decrypt(row.access_token);
  return token === rejectToken ? null : token;
}

/**
 * A working access token for an installation.
 *
 * `rejectToken` is the token a request just got a 401 with: it is never
 * returned again, so the caller's single retry really does use a new one.
 */
export async function installedAccessToken(
  client: SupabaseClient,
  installationId: string,
  options: { rejectToken?: string | null } = {},
): Promise<{ shop: string; token: string }> {
  const rejectToken = options.rejectToken ?? null;

  for (let step = 0; step <= WAIT_STEPS; step++) {
    const row = await readInstallation(client, installationId);
    const shop = row.shop_domain;
    if (row.uninstalled_at) throw new ShopifyNotInstalledError(shop);
    if (row.needs_reauth_at || !row.refresh_token) throw new ShopifyReauthRequiredError(shop);

    const ready = usableToken(row, rejectToken, Date.now());
    if (ready) return { shop, token: ready };

    // Take the lease, or wait for whoever holds it.
    const now = new Date();
    const { data: claimed, error: claimError } = await client
      .from("shopify_installations")
      .update({ refreshing_until: new Date(now.getTime() + LEASE_MS).toISOString() })
      .eq("id", installationId)
      .or(`refreshing_until.is.null,refreshing_until.lt.${now.toISOString()}`)
      .select("id");
    if (claimError) throw new Error(`Could not lock the Shopify installation: ${claimError.message}`);

    if (!claimed || claimed.length === 0) {
      await sleep(WAIT_STEP_MS);
      continue;
    }

    try {
      const fresh = await refreshAccessToken(shop, decrypt(row.refresh_token), requireShopifyAppCredentials());
      await saveInstallationTokens(client, shop, fresh);
      return { shop, token: fresh.accessToken };
    } catch (err) {
      if (err instanceof ShopifyRefreshRevokedError) {
        await client
          .from("shopify_installations")
          .update({ needs_reauth_at: new Date().toISOString(), refreshing_until: null })
          .eq("id", installationId);
        throw new ShopifyReauthRequiredError(shop);
      }
      // Transient: release the lease so the next attempt can retry with the
      // same refresh token, which Shopify keeps valid for exactly this case.
      await client.from("shopify_installations").update({ refreshing_until: null }).eq("id", installationId);
      throw err;
    }
  }
  throw new Error("Timed out waiting for another request to refresh the Shopify token. Try again in a minute.");
}

/**
 * The app was uninstalled: Shopify has already revoked the tokens, so they
 * are dropped, and every connection that publishes through this installation
 * is marked for reconnecting so the dashboard says so instead of failing at
 * the next publish.
 */
export async function markShopUninstalled(client: SupabaseClient, shop: string): Promise<void> {
  const { data } = await client
    .from("shopify_installations")
    .update({
      uninstalled_at: new Date().toISOString(),
      access_token: null,
      access_expires_at: null,
      refresh_token: null,
      refresh_expires_at: null,
      refreshing_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq("shop_domain", shop)
    .select("id");
  for (const row of data ?? []) {
    await client
      .from("workspace_integrations")
      .update({ needs_reconnect: true, last_sync_error: "The AltoRank app was uninstalled from this Shopify store." })
      .eq("integration_id", "shopify")
      .eq("config->>installationId", row.id as string);
  }
}

/**
 * `shop/redact`, 48 hours after uninstall: forget the store. The installation
 * row and every connection made through it go; the articles AltoRank wrote
 * belong to the AltoRank account, not to the store, and stay.
 */
export async function forgetShop(client: SupabaseClient, shop: string): Promise<void> {
  const { data } = await client.from("shopify_installations").select("id").eq("shop_domain", shop);
  for (const row of data ?? []) {
    await client
      .from("workspace_integrations")
      .delete()
      .eq("integration_id", "shopify")
      .eq("config->>installationId", row.id as string);
  }
  await client.from("shopify_installations").delete().eq("shop_domain", shop);
}
