import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptConfig } from "@/lib/crypto";
import { listShopifyBlogs, queryShopify } from "@/lib/cms/shopify";
import { generateIndexNowKey } from "@/lib/seo/indexing";
import { FREE_TIER_PACE } from "@/lib/content/pace";
import { recordEvent } from "@/lib/observability/record";
import { describe as describeError } from "@/lib/observability/event";
import { shopAdminBase } from "./shop-domain";

/**
 * A store's first open of the app: give it an AltoRank account, a site for
 * its storefront domain, and a publishing connection, with nothing asked.
 *
 * Shopify forbids asking a merchant for anything before the app works (App
 * Store requirement 2.3), so this is the signup a store gets instead of the
 * form. It mirrors app/(auth)/signup/page.tsx: an account with its owner, one
 * workspace with the same opt-in defaults, then the same first look.
 *
 * Identity, and why the store's email is not trusted for more than a mailbox:
 * the owner is a new auth user carrying the store's email, UNCONFIRMED - the
 * person who reads that inbox can later claim the account with a sign-in
 * link, and nobody else can. If an AltoRank user already has that email, the
 * store is NOT attached to them (an installer could otherwise reach someone
 * else's account by setting a store email); it gets an owner with a
 * placeholder address instead, and the existing user links the store from
 * their own signed-in dashboard.
 */

export interface ShopFacts {
  name: string;
  email: string | null;
  /** The storefront host merchants and Google see, `www.` stripped. */
  domain: string;
}

export interface ProvisionResult {
  accountId: string;
  workspaceId: string;
  created: boolean;
  /** The owner's email can receive a sign-in link (false for a placeholder). */
  ownerReachable: boolean;
}

const SHOP_QUERY = `query AltoRankShopFacts {
  shop { name email contactEmail myshopifyDomain primaryDomain { host } }
}`;

/** Facts about a store, read with its installation's token. */
export async function readShopFacts(shop: string, installationId: string): Promise<ShopFacts> {
  const data = await queryShopify<{
    shop: {
      name?: string;
      email?: string | null;
      contactEmail?: string | null;
      myshopifyDomain?: string;
      primaryDomain?: { host?: string } | null;
    };
  }>(shopAdminBase(shop), { installationId }, SHOP_QUERY);
  const s = data.shop ?? {};
  const host = (s.primaryDomain?.host || s.myshopifyDomain || shop).toLowerCase().replace(/^www\./, "");
  return {
    name: s.name?.trim() || host,
    email: (s.email || s.contactEmail || "").trim().toLowerCase() || null,
    domain: host,
  };
}

/** An address that can never receive mail (RFC 6761 reserves .invalid). */
function placeholderEmail(shop: string): string {
  const handle = shop.replace(/\.myshopify\.com$/, "");
  return `${handle}.${randomBytes(4).toString("hex")}@shopify-store.altorank.invalid`;
}

async function createOwner(
  admin: SupabaseClient,
  shop: string,
  facts: ShopFacts,
): Promise<{ userId: string; reachable: boolean }> {
  const metadata = { name: facts.name, shopify_shop: shop };
  if (facts.email) {
    const { data, error } = await admin.auth.admin.createUser({
      email: facts.email,
      email_confirm: false,
      user_metadata: metadata,
    });
    if (data?.user) return { userId: data.user.id, reachable: true };
    // Taken by an existing AltoRank user (or otherwise refused): never attach.
    if (error && !/already|registered|exists/i.test(error.message)) {
      throw new Error(`Could not create the store's owner: ${error.message}`);
    }
  }
  const { data, error } = await admin.auth.admin.createUser({
    email: placeholderEmail(shop),
    email_confirm: false,
    user_metadata: { ...metadata, placeholder: true },
  });
  if (!data?.user) throw new Error(`Could not create the store's owner: ${error?.message ?? "no user"}`);
  return { userId: data.user.id, reachable: false };
}

async function createAccount(admin: SupabaseClient, name: string): Promise<string> {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "store";
  let lastError = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 8)}`;
    const { data, error } = await admin.from("accounts").insert({ name, slug }).select("id").single();
    if (data) return data.id as string;
    lastError = error?.message ?? "unknown error";
    if (error?.code !== "23505") break;
  }
  throw new Error(`Could not create the account: ${lastError}`);
}

/**
 * Set the store up, or return what an earlier open already set up.
 * Safe to run twice at once: the installation row is claimed last, with a
 * compare-and-set, and the loser removes what it made.
 */
export async function provisionShop(
  admin: SupabaseClient,
  installation: { id: string; shop: string },
): Promise<ProvisionResult> {
  const { data: current } = await admin
    .from("shopify_installations")
    .select("account_id, workspace_id")
    .eq("id", installation.id)
    .single();
  if (current?.account_id && current?.workspace_id) {
    return { accountId: current.account_id, workspaceId: current.workspace_id, created: false, ownerReachable: true };
  }

  const facts = await readShopFacts(installation.shop, installation.id);
  const owner = await createOwner(admin, installation.shop, facts);
  let accountId: string | null = null;
  try {
    accountId = await createAccount(admin, facts.name);
    const { error: memberError } = await admin
      .from("account_members")
      .insert({ account_id: accountId, user_id: owner.userId, role: "owner" });
    if (memberError) throw new Error(`Could not add the store's owner: ${memberError.message}`);

    const { data: ws, error: wsError } = await admin
      .from("workspaces")
      .insert({
        account_id: accountId,
        name: facts.domain,
        domain: facts.domain,
        initials: facts.domain.slice(0, 2).toUpperCase(),
        color: "av-c1",
        indexnow_key: generateIndexNowKey(),
        // The same opt-in signup records: the merchant installed the app to
        // get exactly this. auto_approve stays at its default (off).
        auto_generate: true,
        auto_generate_weekly_limit: FREE_TIER_PACE,
      })
      .select("id")
      .single();
    if (!ws) throw new Error(`Could not create the site: ${wsError?.message ?? "no row"}`);

    // The first blog, as the manual connect defaults to; changeable in the app.
    const blogs = await listShopifyBlogs(shopAdminBase(installation.shop), { installationId: installation.id }).catch(() => []);
    const blog = blogs[0];
    const { error: connError } = await admin.from("workspace_integrations").upsert(
      {
        workspace_id: ws.id,
        integration_id: "shopify",
        config: encryptConfig({
          type: "shopify",
          storeUrl: shopAdminBase(installation.shop),
          installationId: installation.id,
          ...(blog ? { blogId: blog.id, blogHandle: blog.handle } : {}),
        }),
        // Drafts: every article lands hidden in Shopify until the merchant
        // shows it, matching the manual connection's default.
        publish_mode: "draft",
        connected_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,integration_id" },
    );
    if (connError) throw new Error(`Could not connect the store: ${connError.message}`);

    const { data: claimed } = await admin
      .from("shopify_installations")
      .update({
        account_id: accountId,
        workspace_id: ws.id,
        shop_name: facts.name,
        primary_domain: facts.domain,
        updated_at: new Date().toISOString(),
      })
      .eq("id", installation.id)
      .is("account_id", null)
      .select("id");
    if (!claimed?.length) throw new LostRaceError();

    await recordEvent(
      {
        level: "info",
        source: "signup",
        message: `Account created, from the Shopify App Store (${installation.shop})`,
        accountId,
        workspaceId: ws.id as string,
        context: { stage: "created", userId: owner.userId, domain: facts.domain, source: "shopify", shop: installation.shop },
      },
      admin,
    );
    return { accountId, workspaceId: ws.id as string, created: true, ownerReachable: owner.reachable };
  } catch (err) {
    // Undo this attempt: the account delete cascades to its membership,
    // site and connection, and the owner is removed after it.
    if (accountId) await admin.from("accounts").delete().eq("id", accountId);
    await admin.auth.admin.deleteUser(owner.userId).catch(() => undefined);
    if (err instanceof LostRaceError) return provisionShop(admin, installation);
    await recordEvent(
      {
        level: "error",
        source: "shopify.provision",
        message: `Could not set up ${installation.shop}: ${describeError(err)}`,
        context: { shop: installation.shop },
      },
      admin,
    );
    throw err;
  }
}

class LostRaceError extends Error {
  constructor() {
    super("Another request set this store up first");
  }
}
