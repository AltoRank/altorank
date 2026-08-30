"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { resolveCMSAdapter } from "@/lib/cms/adapter";
import { encryptConfig, decryptConfig } from "@/lib/crypto";
import type { CMSConfig } from "@/lib/types";
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
]);

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
