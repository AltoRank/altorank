"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { resolveCMSAdapter } from "@/lib/cms/adapter";
import { encryptConfig, decryptConfig } from "@/lib/crypto";
import type { CMSConfig } from "@/lib/types";
import { deriveBlogBaseUrl } from "@/lib/cms/blog-url";
import { z } from "zod";

const wordpressSchema = z.object({
  type: z.literal("wordpress"),
  siteUrl: z.string().url(),
  username: z.string().min(1),
  applicationPassword: z.string().min(1),
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

export async function connectIntegration(
  workspaceId: string,
  integrationId: string,
  config: CMSConfig
) {
  await requireAuth();

  // Validate config
  const parsed = configSchema.parse(config);

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
