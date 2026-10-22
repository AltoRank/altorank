import type { SupabaseClient } from "@supabase/supabase-js";
import type { CrawlResult } from "@/lib/audit/crawler";
import { decryptConfig } from "@/lib/crypto";
import { queryShopify } from "@/lib/cms/shopify";
import { storefrontLocked } from "./first-look";
import { storefrontWalled } from "./bot-wall";
import type { ShopifyCredentials } from "@/lib/types";

/** The connection's credential, whichever kind it is; null when it has none. */
export function credentialsFrom(config: Record<string, unknown>): ShopifyCredentials | null {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const installationId = str(config.installationId);
  if (installationId) return { installationId };
  const accessToken = str(config.accessToken);
  if (accessToken) return { accessToken };
  const clientId = str(config.clientId);
  const clientSecret = str(config.clientSecret);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * A Shopify store's own words, read through the Admin API, for a first look
 * whose storefront cannot be crawled.
 *
 * A store behind Shopify's password page - one still being built, and every
 * development store, the kind App Store reviewers install on - answers every
 * page with /password, so the crawl reads nothing and the whole first look
 * skips. The app's scopes cover the store's pages and blog articles
 * (read_content) and its products (read_products): the same text the
 * storefront would show. That is
 * read here and shaped like crawled pages, so the topical profile, keyword
 * research and voice work as they do for any site.
 *
 * For any Shopify connection: the App Store install (config.installationId)
 * or a merchant's own custom app connected from /connect (an access token, or
 * a client id and secret). The pages stand in for the crawl only when the
 * storefront cannot be read (`locked`): behind Shopify's password page, or
 * behind the store's own bot wall (lib/shopify/bot-wall.ts). An open
 * storefront is crawled as before, rendered pages being the better evidence. Either way the catalogue is what the business
 * profile is inferred from, since an App Store install never saw the wizard
 * that would have asked (lib/onboarding/pipeline.ts).
 */

export interface StoreContent {
  /** Shaped like crawl results, for analyseDomain's `pages`. */
  pages: CrawlResult[];
  /** Plain text of the pages, for the voice. */
  text: string;
  /** Plain text of the newest articles, for the voice. */
  articleText: string;
  /**
   * What the store is and sells, for inferring its business profile: the
   * pages' text plus one line per product. A store's catalogue is often all
   * titles and tags with no descriptions, which is too little prose for a
   * voice and plenty to say what is sold.
   */
  profileText: string;
  /** The storefront answers with its password page or refuses us: the pages replace the crawl. */
  locked: boolean;
}

const STORE_CONTENT = `query AltoRankStoreContent {
  shop { name description }
  pages(first: 50) { nodes { title handle body bodySummary } }
  articles(first: 40, sortKey: PUBLISHED_AT, reverse: true) { nodes { title handle body summary blog { handle } } }
}`;

/**
 * Asked apart from the rest: a store that installed before the app asked for
 * read_products answers this with ACCESS_DENIED until it approves the new
 * scope, and that must cost the products, not the pages and articles.
 */
const STORE_PRODUCTS = `query AltoRankStoreProducts {
  products(first: 50, query: "status:active") { nodes { title handle description productType vendor tags } }
}`;

interface StoreContentResponse {
  shop?: { name?: string | null; description?: string | null };
  pages?: { nodes?: Array<{ title?: string; handle?: string; body?: string | null; bodySummary?: string | null }> };
  products?: {
    nodes?: Array<{ title?: string; handle?: string; description?: string | null; productType?: string | null; vendor?: string | null; tags?: string[] | null }>;
  };
  articles?: {
    nodes?: Array<{ title?: string; handle?: string; body?: string | null; summary?: string | null; blog?: { handle?: string } | null }>;
  };
}

/** HTML to readable text: tags out, entities for the common few, whitespace folded. */
export function htmlToText(html: string | null | undefined): string {
  return (html ?? "")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|h[1-6]|li|div)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function headings(html: string | null | undefined, level: 1 | 2): string[] {
  const out: string[] = [];
  const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)</h${level}>`, "gi");
  for (const m of (html ?? "").matchAll(re)) {
    const t = htmlToText(m[1]);
    if (t) out.push(t);
  }
  return out;
}

/** A page's text as the profile reads it: the body's opening, where a page states what it is about. */
function lead(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

function page(url: string, title: string, bodyHtml: string | null | undefined, summary?: string | null): CrawlResult {
  const text = htmlToText(bodyHtml);
  return {
    url,
    status: 200,
    title,
    metaDescription: lead(htmlToText(summary) || text),
    h1: [title, ...headings(bodyHtml, 1)].filter(Boolean),
    h2: headings(bodyHtml, 2),
    images: [],
    links: [],
    loadTimeMs: 0,
  };
}

/**
 * Pages every store has and none is about: the policies Shopify generates and
 * the contact form. A dev store has nothing else, and a topical profile of
 * "privacy, personal information, cookies" plans articles on privacy law.
 */
const BOILERPLATE = /(^|-)(privacy|contact|terms|refund|return|shipping|policy|policies|cookie|legal|data-sharing|opt-out|your-privacy-choices)(-|$)/;

/** Shape an Admin API answer into pages and text. Pure, for tests. */
export function storeContentFrom(domain: string, data: StoreContentResponse): Omit<StoreContent, "locked"> {
  const base = `https://${domain}`;
  const pages: CrawlResult[] = [];
  const texts: string[] = [];
  const articleTexts: string[] = [];
  const catalogue: string[] = [];

  const name = data.shop?.name?.trim() ?? "";
  const description = data.shop?.description?.trim() ?? "";
  if (name || description) {
    pages.push({ ...page(`${base}/`, name || domain, null), metaDescription: description, h1: name ? [name] : [] });
    if (description) texts.push(description);
  }
  for (const p of data.pages?.nodes ?? []) {
    if (!p.title || BOILERPLATE.test((p.handle ?? "").toLowerCase())) continue;
    pages.push(page(`${base}/pages/${p.handle ?? ""}`, p.title, p.body, p.bodySummary));
    const t = htmlToText(p.body);
    if (t) texts.push(`${p.title}\n${t}`);
  }
  // What the store sells, in its own words: for most stores this is nearly
  // all the copy there is. The type and tags carry the category vocabulary a
  // buyer searches with, so they go in the headings the profile weighs.
  for (const p of data.products?.nodes ?? []) {
    if (!p.title) continue;
    const description = (p.description ?? "").trim();
    pages.push({
      ...page(`${base}/products/${p.handle ?? ""}`, p.title, null),
      metaDescription: lead(description),
      h2: [p.productType, ...(p.tags ?? [])].filter((t): t is string => Boolean(t && t.trim())),
    });
    if (description) texts.push(`${p.title}\n${description}`);
    catalogue.push(
      [p.title, p.productType, p.vendor && `by ${p.vendor}`, p.tags?.length && `tags: ${p.tags.join(", ")}`, lead(description, 160)]
        .filter(Boolean)
        .join(" - "),
    );
  }
  // Newest first, so the voice sample is the store's current writing.
  for (const a of data.articles?.nodes ?? []) {
    if (!a.title) continue;
    pages.push(page(`${base}/blogs/${a.blog?.handle ?? ""}/${a.handle ?? ""}`, a.title, a.body, a.summary));
    const t = htmlToText(a.body);
    if (t) articleTexts.push(`${a.title}\n${t}`);
  }
  const profileText = [
    name && `STORE: ${name}`,
    texts.join("\n\n"),
    catalogue.length && `PRODUCTS (${catalogue.length}):\n${catalogue.map((c) => `- ${c}`).join("\n")}`,
    articleTexts.length && `ARTICLES:\n${articleTexts.map((a) => a.split("\n")[0]).join("\n")}`,
  ].filter(Boolean).join("\n\n");
  return { pages, text: texts.join("\n\n"), articleText: articleTexts.slice(0, 2).join("\n\n"), profileText };
}

/**
 * The store's content, or null: no Shopify connection, or the API
 * refused. `locked` says whether it should replace the crawl.
 */
export async function installedStoreContent(
  supabase: SupabaseClient,
  workspaceId: string,
  domain: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<StoreContent | null> {
  // Optional by design: anything that goes wrong here leaves the first look
  // to the crawl it would have done anyway, never fails it.
  try {
    return await readStoreContent(supabase, workspaceId, domain, deps);
  } catch (err) {
    console.warn(`[first-look] could not check for a locked Shopify store: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function readStoreContent(
  supabase: SupabaseClient,
  workspaceId: string,
  domain: string,
  deps: { fetchImpl?: typeof fetch },
): Promise<StoreContent | null> {
  const { data: conn } = await supabase
    .from("workspace_integrations")
    .select("config")
    .eq("workspace_id", workspaceId)
    .eq("integration_id", "shopify")
    .maybeSingle();
  if (!conn) return null;
  const config = decryptConfig(conn.config as Record<string, unknown>);
  const storeUrl = typeof config.storeUrl === "string" ? config.storeUrl : null;
  const credentials = credentialsFrom(config);
  if (!credentials || !storeUrl) return null;

  try {
    const [locked, data, products] = await Promise.all([
      Promise.all([storefrontLocked(domain, deps.fetchImpl), storefrontWalled(domain, deps.fetchImpl)]).then(([pw, wall]) => pw || wall),
      queryShopify<StoreContentResponse>(storeUrl, credentials, STORE_CONTENT),
      queryShopify<Pick<StoreContentResponse, "products">>(storeUrl, credentials, STORE_PRODUCTS).catch((err) => {
        console.warn(`[first-look] products not readable (read_products not approved yet?): ${err instanceof Error ? err.message : err}`);
        return {};
      }),
    ]);
    const content = storeContentFrom(domain, { ...data, ...products });
    return content.pages.length ? { ...content, locked } : null;
  } catch (err) {
    console.warn(`[first-look] could not read the store's content through Shopify: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
