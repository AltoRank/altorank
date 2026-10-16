import { NextResponse } from "next/server";
import { decryptConfig } from "@/lib/crypto";
import { listShopifyBlogs } from "@/lib/cms/shopify";
import { getQuota } from "@/lib/billing/quota";
import { PLAN_LABELS } from "@/lib/stripe";
import { STATUS_LABELS } from "@/lib/agent/records";
import { authenticateLinkedShop } from "@/lib/shopify/request-auth";
import { shopAdminBase } from "@/lib/shopify/shop-domain";
import { firstLookView } from "@/lib/shopify/first-look";
import { accountOwner } from "@/lib/shopify/owner";
import type { Article } from "@/lib/types";

/** The statuses the embedded queue lists: what is waiting, and what just went out. */
const QUEUE_STATUSES = ["review", "approved", "scheduled", "live", "error"] as const;

/**
 * GET /api/shopify/state - everything the embedded app's home screen shows.
 *
 * Every read is scoped to the account and site the store's installation
 * names (lib/shopify/request-auth.ts); nothing the client sends picks a row.
 * Article bodies are never read here - the list is titles and statuses.
 */
export async function GET(request: Request) {
  const auth = await authenticateLinkedShop(request);
  if (!auth.ok) return auth.response;
  const { supabase, shop, installation } = auth.ctx;
  const { accountId, workspaceId } = installation;

  const [{ data: site }, { data: conn }, { data: articles }, quota, firstLook, owner] = await Promise.all([
    supabase.from("workspaces").select("domain").eq("id", workspaceId).eq("account_id", accountId).maybeSingle(),
    supabase
      .from("workspace_integrations")
      .select("config, publish_mode, needs_reconnect")
      .eq("workspace_id", workspaceId)
      .eq("integration_id", "shopify")
      .eq("config->>installationId", installation.id)
      .maybeSingle(),
    supabase
      .from("articles")
      .select("id, title, keyword, status, updated_at")
      .eq("workspace_id", workspaceId)
      .in("status", QUEUE_STATUSES)
      .order("updated_at", { ascending: false })
      .limit(25),
    getQuota(supabase, accountId, null),
    firstLookView(supabase, workspaceId),
    accountOwner(supabase, accountId),
  ]);

  const config = conn ? decryptConfig(conn.config as Record<string, unknown>) : null;
  const blogs = conn
    ? await listShopifyBlogs(shopAdminBase(shop), { installationId: installation.id }).catch(() => [])
    : [];

  // Waiting first, then the rest by recency.
  const queue = (articles ?? [])
    .map((a) => ({
      id: a.id as string,
      title: (a.title as string) || "Untitled draft",
      keyword: (a.keyword as string) || "",
      status: a.status as string,
      statusLabel: STATUS_LABELS[a.status as Article["status"]] ?? (a.status as string),
    }))
    .sort((a, b) => Number(b.status === "review") - Number(a.status === "review"));

  return NextResponse.json({
    shop: { domain: shop, name: installation.shopName },
    site: { domain: (site?.domain as string | undefined) ?? shop },
    plan: planView(quota),
    firstLook,
    connection: {
      blogs: blogs.map((b) => ({ id: b.id, title: b.title })),
      blogId: (config?.blogId as string | undefined) ?? blogs[0]?.id ?? null,
      publishMode: (conn?.publish_mode as string | undefined) ?? "draft",
      needsReconnect: !conn || Boolean(conn.needs_reconnect),
    },
    queue,
    account: {
      ownerEmail: owner && !owner.placeholder ? owner.email : null,
      ownerReachable: Boolean(owner && !owner.placeholder && owner.email),
    },
  });
}

function planView(quota: Awaited<ReturnType<typeof getQuota>>): { label: string; line: string; needsPlan: boolean } {
  const left =
    quota.remaining === null ? "unlimited drafts" : `${quota.remaining} draft${quota.remaining === 1 ? "" : "s"} left this month`;
  if (quota.reason === "plan" && quota.plan) {
    return { label: quota.trial ? `${PLAN_LABELS[quota.plan]} (trial)` : PLAN_LABELS[quota.plan], line: left, needsPlan: false };
  }
  if (quota.reason === "no-plan") {
    return { label: "No plan yet", line: "Your first draft is free to write. Approving and publishing needs a plan.", needsPlan: true };
  }
  return { label: "Unmetered", line: left, needsPlan: false };
}
