import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { recordEvent } from "@/lib/observability/record";
import { describe as describeError } from "@/lib/observability/event";
import { shopifyAppCredentials } from "@/lib/shopify/env";
import { normaliseShopDomain } from "@/lib/shopify/shop-domain";
import { verifyShopifyWebhook } from "@/lib/shopify/webhook-hmac";
import { forgetShop, markShopUninstalled } from "@/lib/shopify/installations";
import { SHOPIFY_WEBHOOK_TOPICS, type ShopifyWebhookTopic } from "@/lib/shopify/webhook-topics";

/**
 * Every webhook the AltoRank Shopify app receives.
 *
 * 1. The HMAC is checked over the raw body before anything is parsed; a bad
 *    one is a 401, which Shopify's review checks for explicitly.
 * 2. The delivery is claimed by X-Shopify-Webhook-Id, so a redelivery after a
 *    timeout does nothing twice. If handling throws, the claim is released
 *    and the 500 makes Shopify retry.
 * 3. The answer is a fast 200.
 *
 * What each topic does, and why the customer topics do nothing: AltoRank
 * reads and writes a store's blog articles and never reads its customers or
 * orders (the app asks for read_content and write_content only), so there is
 * no customer data to report or erase. The privacy topics are still received,
 * verified and recorded, as the App Store requires.
 * https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 * https://shopify.dev/docs/apps/build/webhooks/subscribe/https
 */
export async function POST(request: Request) {
  const app = shopifyAppCredentials();
  const rawBody = await request.text();
  if (!app || !verifyShopifyWebhook(rawBody, request.headers.get("x-shopify-hmac-sha256"), app.clientSecret)) {
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
  }

  const topic = request.headers.get("x-shopify-topic") ?? "";
  const shop = normaliseShopDomain(request.headers.get("x-shopify-shop-domain"));
  const webhookId = request.headers.get("x-shopify-webhook-id") ?? request.headers.get("x-shopify-event-id");
  if (!shop || !webhookId) return NextResponse.json({ error: "Missing shop or webhook id" }, { status: 400 });
  if (!(SHOPIFY_WEBHOOK_TOPICS as readonly string[]).includes(topic)) {
    // Signed by Shopify but not a topic we subscribe to: acknowledge, ignore.
    return NextResponse.json({ received: true, ignored: topic });
  }

  const supabase = createServiceClient();
  const { error: claimError } = await supabase
    .from("shopify_webhook_events")
    .insert({ webhook_id: webhookId, topic, shop_domain: shop });
  if (claimError) {
    if (claimError.code === "23505") return NextResponse.json({ received: true, duplicate: true });
    return NextResponse.json({ error: "Could not record the delivery" }, { status: 500 });
  }

  try {
    await handle(topic as ShopifyWebhookTopic, shop, supabase);
  } catch (err) {
    await supabase.from("shopify_webhook_events").delete().eq("webhook_id", webhookId);
    await recordEvent(
      {
        level: "error",
        source: "shopify.webhook",
        message: `${topic} for ${shop} could not be processed: ${describeError(err)}`,
        context: { topic, shop, webhookId },
      },
      supabase,
    );
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

async function handle(
  topic: ShopifyWebhookTopic,
  shop: string,
  supabase: ReturnType<typeof createServiceClient>,
): Promise<void> {
  switch (topic) {
    case "app/uninstalled":
      await markShopUninstalled(supabase, shop);
      return;
    case "shop/redact":
      await forgetShop(supabase, shop);
      return;
    case "customers/data_request":
    case "customers/redact":
      // No customer data is ever read or stored; see the note above.
      await recordEvent(
        { level: "info", source: "shopify.webhook", message: `${topic} for ${shop}: no customer data held`, context: { topic, shop } },
        supabase,
      );
      return;
  }
}
