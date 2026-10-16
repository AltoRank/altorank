import { NextResponse } from "next/server";
import { z } from "zod";
import { decryptConfig, encryptConfig } from "@/lib/crypto";
import { listShopifyBlogs } from "@/lib/cms/shopify";
import { authenticateLinkedShop } from "@/lib/shopify/request-auth";
import { shopAdminBase } from "@/lib/shopify/shop-domain";

/**
 * PUT /api/shopify/connection - the blog and publish mode, from the embedded app.
 *
 * Only the store's own App Store connection can be changed here: the row is
 * found by the installation the ID token resolved to, never by anything the
 * client names. The blog must be one Shopify lists for this store.
 */
const body = z.object({
  blogId: z.string().min(1),
  publishMode: z.enum(["draft", "publish"]),
});

export async function PUT(request: Request) {
  const auth = await authenticateLinkedShop(request);
  if (!auth.ok) return auth.response;
  const { supabase, shop, installation } = auth.ctx;

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose a blog and a publish mode." }, { status: 400 });

  const { data: row } = await supabase
    .from("workspace_integrations")
    .select("id, config")
    .eq("workspace_id", installation.workspaceId)
    .eq("integration_id", "shopify")
    .eq("config->>installationId", installation.id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "This store's connection is missing. Reload the app." }, { status: 409 });

  const blogs = await listShopifyBlogs(shopAdminBase(shop), { installationId: installation.id });
  const blog = blogs.find((b) => b.id === parsed.data.blogId);
  if (!blog) return NextResponse.json({ error: "That blog is not on this store any more." }, { status: 400 });

  const config = decryptConfig(row.config as Record<string, unknown>);
  const { error } = await supabase
    .from("workspace_integrations")
    .update({
      config: encryptConfig({ ...config, blogId: blog.id, blogHandle: blog.handle }),
      publish_mode: parsed.data.publishMode,
    })
    .eq("id", row.id);
  if (error) return NextResponse.json({ error: "Could not save. Try again." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
