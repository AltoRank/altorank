import type { Metadata } from "next";
import { requireAuth } from "@/lib/auth/require-auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { canAddWorkspace } from "@/lib/team/access";
import { readLinkSource, sourceRetirementBlocker, verifyLinkToken } from "@/lib/shopify/link";
import { PageHead, Card } from "@/components/ui";
import { ShopifyLinkForm } from "./link-form";

export const metadata: Metadata = { title: "Connect a Shopify store" };

/**
 * /connect/shopify?token=… - opened from AltoRank inside the Shopify admin
 * ("Use an AltoRank account I already have"). The signed link names the
 * store; the session names the account that takes it (lib/shopify/link.ts).
 */
export default async function ConnectShopifyPage(props: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await props.searchParams;
  const { accountId, role } = await requireAuth();

  const refuse = (message: string) => (
    <div className="space-y-5">
      <PageHead title="Connect a Shopify store" />
      <Card title="This link cannot be used">
        <p className="text-[13px] text-ink-2">{message}</p>
      </Card>
    </div>
  );

  if (!canAddWorkspace(role)) return refuse("Only an owner or admin of this account can connect a store to it.");
  const verified = verifyLinkToken(token);
  if (!verified.ok) return refuse(verified.reason);
  const db = createServiceClient();
  const source = await readLinkSource(db, verified.payload);
  if ("error" in source) return refuse(source.error);
  if (source.fromAccountId === accountId) return refuse("This store is already on this account.");
  const blocker = await sourceRetirementBlocker(db, source);
  if (blocker) return refuse(blocker);

  const supabase = await createClient();
  const { data: sites } = await supabase
    .from("workspaces")
    .select("id, name, domain")
    .eq("account_id", accountId)
    .order("created_at", { ascending: true });

  const storeName = source.shopName ?? source.shop;
  return (
    <div className="space-y-5">
      <PageHead
        title="Connect a Shopify store"
        subtitle={`${storeName} (${source.shop}) will publish through the site you choose.`}
      />
      <Card title="Which site is this store?">
        <ShopifyLinkForm
          token={token!}
          storeDomain={source.domain}
          sites={(sites ?? []).map((s) => ({ id: s.id as string, label: `${s.name ?? s.domain} · ${s.domain ?? ""}` }))}
          suggestedSiteId={(sites ?? []).find((s) => s.domain && s.domain === source.domain)?.id as string | undefined}
        />
        <p className="mt-4 text-[12px] text-ink-3">
          The AltoRank account the store made when it was installed is removed, with the free draft it wrote.
        </p>
      </Card>
    </div>
  );
}
