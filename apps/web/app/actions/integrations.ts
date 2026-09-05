"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { resolveCMSAdapter } from "@/lib/cms/adapter";
import { encryptConfig, decryptConfig } from "@/lib/crypto";
import type { CMSConfig } from "@/lib/types";
import { deriveBlogBaseUrl } from "@/lib/cms/blog-url";
import { assertPublishMode, DEFAULT_PUBLISH_MODE, type PublishMode } from "@/lib/cms/publish-mode";
import { listWebflowSites, listWebflowCollections, listWebflowFields } from "@/lib/cms/webflow";
import { listWixSites } from "@/lib/cms/wix";
import { listShopifyBlogs } from "@/lib/cms/shopify";
import { z } from "zod";

const wordpressSchema = z.object({
  type: z.literal("wordpress"),
  siteUrl: z.string().url(),
  username: z.string().min(1),
  applicationPassword: z.string().min(1),
});

/**
 * The plugin path. The token is what the connect dialog generated - 32 random
 * bytes as hex - and the plugin compares it with hash_equals, so its shape is
 * checked here too: anything else was typed by hand and will never match.
 */
const wordpressPluginSchema = z.object({
  type: z.literal("wordpress-plugin"),
  siteUrl: z.string().url(),
  token: z.string().regex(/^[0-9a-f]{64}$/, "Integration token must be 64 hex characters"),
});

const shopifySchema = z.object({
  type: z.literal("shopify"),
  storeUrl: z.string().url(),
  accessToken: z.string().min(1),
  blogId: z.string().optional(),
});

const magentoSchema = z.object({
  type: z.literal("magento"),
  baseUrl: z.string().url(),
  adminToken: z.string().min(1),
  storeCode: z.string().optional(),
});

const webflowSchema = z.object({
  type: z.literal("webflow"),
  siteId: z.string().min(1),
  collectionId: z.string().min(1),
  apiToken: z.string().min(1),
  // Field slugs chosen from the collection's own schema in the connect
  // dialog. Optional so connections saved before the picker existed still
  // parse; the adapter falls back to the template slugs for those.
  fieldMap: z
    .object({
      title: z.string().min(1),
      slug: z.string().min(1),
      body: z.string().min(1),
      summary: z.string().min(1).optional(),
      image: z.string().min(1).optional(),
    })
    .optional(),
});

const ghostSchema = z.object({
  type: z.literal("ghost"),
  apiUrl: z.string().url(),
  adminApiKey: z.string().min(1),
});

const framerSchema = z.object({
  type: z.literal("framer"),
  siteId: z.string().min(1),
  collectionId: z.string().min(1),
  apiToken: z.string().min(1),
});

const wixSchema = z.object({
  type: z.literal("wix"),
  accountId: z.string().min(1),
  siteId: z.string().min(1),
  apiKey: z.string().min(1),
});

const notionSchema = z.object({
  type: z.literal("notion"),
  databaseId: z.string().min(1),
  integrationToken: z.string().min(1),
  // The draft story for Notion: a Status property to set. Optional, because a
  // connection that publishes live needs none; required in effect for a draft
  // connection, which assertPublishMode enforces below.
  statusProperty: z.string().optional(),
  draftStatus: z.string().optional(),
  publishedStatus: z.string().optional(),
});

const hubspotSchema = z.object({
  type: z.literal("hubspot"),
  accessToken: z.string().min(1),
  blogId: z.string().optional(),
});

const woocommerceSchema = z.object({
  type: z.literal("woocommerce"),
  siteUrl: z.string().url(),
  username: z.string().min(1),
  applicationPassword: z.string().min(1),
});

const webhookSchema = z.object({
  type: z.literal("webhook"),
  url: z.string().url(),
  secret: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

/**
 * The static-site case. lib/cms/git.ts existed and was tested for months before
 * this schema did, which meant the adapter was unreachable: connectIntegration
 * parses through this union, so a type missing from it cannot be saved by any
 * route. lib/cms/detect.ts meanwhile told Astro, Hugo, Jekyll and Next sites
 * that git was their answer, and the picker did not offer it.
 *
 * publicBaseUrl and trailingSlash are prefilled from the site's own sitemap by
 * lib/cms/blog-url.ts and verified by GitAdapter.testConnection() before this
 * ever saves, so they are checked values rather than typed guesses.
 */
const gitSchema = z.object({
  type: z.literal("git"),
  provider: z.literal("github"),
  token: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1),
  contentPath: z.string().min(1),
  extension: z.enum(["md", "mdx"]).optional(),
  frontmatterDefaults: z
    .record(z.string(), z.union([z.string(), z.boolean(), z.array(z.string())]))
    .optional(),
  publicBaseUrl: z.string().url().optional(),
  trailingSlash: z.boolean().optional(),
  committer: z.object({ name: z.string().min(1), email: z.string().email() }).optional(),
});

const configSchema = z.discriminatedUnion("type", [
  wordpressSchema,
  wordpressPluginSchema,
  shopifySchema,
  magentoSchema,
  webflowSchema,
  ghostSchema,
  framerSchema,
  wixSchema,
  notionSchema,
  hubspotSchema,
  woocommerceSchema,
  webhookSchema,
  gitSchema,
]);

/**
 * Read a site's post directory off its own sitemap, for the git connect form.
 *
 * A server action because the derivation fetches the customer's site
 * cross-origin, which the browser will not do. Returns null when the site has
 * nothing published yet - a real case for a new blog, and the form then asks
 * rather than prefilling.
 */
export async function deriveBlogUrl(siteUrl: string) {
  await requireAuth();
  return deriveBlogBaseUrl(siteUrl);
}

const publishModeSchema = z.enum(["publish", "draft"]);

// ---------------------------------------------------------------------------
// Discovery, for the connect dialog's pickers
// ---------------------------------------------------------------------------
//
// Each one takes the credential the person just typed, asks the vendor what it
// can see, and returns the list or the vendor's own error text. Nothing is
// stored and nothing is logged: the token is in the argument and nowhere else.
// They call the adapters' listing functions rather than fetching themselves,
// so the picker and the publisher speak to the vendor in one voice.

export type ListResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function attempt<T>(fn: () => Promise<T>): Promise<ListResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function listWebflowSitesAction(apiToken: string) {
  await requireAuth();
  return attempt(() => listWebflowSites(apiToken));
}

export async function listWebflowCollectionsAction(apiToken: string, siteId: string) {
  await requireAuth();
  return attempt(() => listWebflowCollections(apiToken, siteId));
}

export async function listWebflowFieldsAction(apiToken: string, collectionId: string) {
  await requireAuth();
  return attempt(() => listWebflowFields(apiToken, collectionId));
}

export async function listWixSitesAction(apiKey: string, accountId: string) {
  await requireAuth();
  return attempt(() => listWixSites(apiKey, accountId));
}

export async function listShopifyBlogsAction(storeUrl: string, accessToken: string) {
  await requireAuth();
  return attempt(() => listShopifyBlogs(storeUrl, accessToken));
}

/**
 * The same live test connectIntegration runs, without the save.
 *
 * "Send test" in the dialog: the person sees the vendor's exact answer to the
 * values as typed, and can fix them before anything is stored. The publish
 * mode is checked too, so a draft connection to a platform that cannot draft
 * fails here with the same sentence it would fail with on save.
 */
export async function testIntegrationConfig(
  config: CMSConfig,
  publishMode: PublishMode = DEFAULT_PUBLISH_MODE,
): Promise<ListResult<true>> {
  await requireAuth();
  return attempt(async () => {
    const parsed = configSchema.parse(config);
    const mode = publishModeSchema.parse(publishMode);
    assertPublishMode(parsed, mode);
    const test = await resolveCMSAdapter(parsed).testConnection();
    if (!test.ok) throw new Error(test.error ?? "Connection failed");
    return true as const;
  });
}

export async function connectIntegration(
  workspaceId: string,
  integrationId: string,
  config: CMSConfig,
  /**
   * Drafts unless the person chose otherwise. Refused outright when the
   * platform cannot save a draft, before the connection test and before
   * anything is stored: a connection that says "draft" and publishes live
   * is the one outcome this must never produce.
   */
  publishMode: PublishMode = DEFAULT_PUBLISH_MODE,
) {
  await requireAuth();

  // Validate config
  const parsed = configSchema.parse(config);
  const mode = publishModeSchema.parse(publishMode);
  assertPublishMode(parsed, mode);

  // Test connection before saving (uses plaintext credentials)
  const adapter = resolveCMSAdapter(parsed);
  const test = await adapter.testConnection();

  if (!test.ok) {
    throw new Error(`Connection failed: ${test.error}`);
  }

  // Encrypt sensitive fields before storage
  const encryptedConfig = encryptConfig(parsed as unknown as Record<string, unknown>);

  const supabase = await createClient();

  const { error } = await supabase
    .from("workspace_integrations")
    .upsert({
      workspace_id: workspaceId,
      integration_id: integrationId,
      config: encryptedConfig,
      publish_mode: mode,
      connected_at: new Date().toISOString(),
    }, {
      onConflict: "workspace_id,integration_id",
    });

  if (error) throw new Error(error.message);
  revalidatePath("/connect");
}

export async function disconnectIntegration(id: string) {
  await requireAuth();
  const supabase = await createClient();

  const { error } = await supabase
    .from("workspace_integrations")
    .delete()
    .eq("id", id);

  if (error) throw new Error(error.message);
  revalidatePath("/connect");
}

export async function testConnection(id: string) {
  await requireAuth();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("workspace_integrations")
    .select("config")
    .eq("id", id)
    .single();

  if (error || !data) throw new Error("Integration not found");

  // Decrypt sensitive fields before testing
  const config = decryptConfig(data.config as Record<string, unknown>) as CMSConfig;
  const adapter = resolveCMSAdapter(config);
  return adapter.testConnection();
}
