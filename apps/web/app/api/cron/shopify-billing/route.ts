import { NextResponse, after } from "next/server";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { observedCron } from "@/lib/observability/cron";
import { describe as describeError } from "@/lib/observability/event";
import { syncShopifyBilling } from "@/lib/shopify/billing";
import { dispatchResume } from "@/lib/plan/resume-dispatch";

export const maxDuration = 300;

/** The Partner API allows four requests a second; each store costs up to two. */
const SPACING_MS = 600;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Daily: every installed store's plan, from the Partner API.
 *
 * Shopify App Pricing sends no webhook when a subscription is cancelled,
 * frozen or lapses outside a visit to the app, and a store that never opens
 * the app again would otherwise keep a plan it stopped paying for. The same
 * sync runs on every open of the app; this is the catch-up.
 */
async function run(request: Request): Promise<Response> {
  if (!isAuthorizedCron(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!process.env.SHOPIFY_PARTNER_API_TOKEN) {
    return NextResponse.json({ synced: 0, reason: "Shopify billing is not configured on this install" });
  }

  const supabase = createServiceClient();
  const { data: installs, error } = await supabase
    .from("shopify_installations")
    .select("id, shop_domain, account_id, shop_gid")
    .is("uninstalled_at", null)
    .not("account_id", "is", null)
    .order("plan_checked_at", { ascending: true, nullsFirst: true })
    .limit(300);
  if (error) throw new Error(`could not list Shopify installations (${error.message})`);

  let synced = 0;
  const failed: Array<{ shop: string; error: string }> = [];
  for (const inst of installs ?? []) {
    try {
      const { resume } = await syncShopifyBilling(supabase, {
        id: inst.id as string,
        shop: inst.shop_domain as string,
        accountId: inst.account_id as string,
        shopGid: (inst.shop_gid as string | null) ?? null,
      });
      if (resume) after(() => dispatchResume(resume));
      synced++;
    } catch (err) {
      failed.push({ shop: inst.shop_domain as string, error: describeError(err) });
    }
    await sleep(SPACING_MS);
  }
  return NextResponse.json({ synced, failed });
}

export const GET = observedCron("cron.shopify-billing", run);
