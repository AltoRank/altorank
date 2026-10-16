import type { SupabaseClient } from "@supabase/supabase-js";
import type { CrawlResult } from "@/lib/audit/crawler";
import { decryptConfig } from "@/lib/crypto";
import { queryShopify } from "@/lib/cms/shopify";
import { storefrontLocked } from "./first-look";

/**
 * A Shopify store's own words, read through the Admin API, for a first look
 * whose storefront cannot be crawled.
 *
 * A store behind Shopify's password page - one still being built, and every
 * development store, the kind App Store reviewers install on - answers every
 * page with /password, so the crawl reads nothing and the whole first look
 * skips. The store installed AltoRank with read_content, which covers its
 * pages and blog articles: the same text the storefront would show. That is
 * read here and shaped like crawled pages, so the topical profile, keyword
 * research and voice work as they do for any site.
 *
 * Only for a connection made by the App Store install (config.installationId)
 * and only when the storefront is actually locked: an open storefront is
 * crawled as before, rendered pages being the better evidence.
 */

export interface StoreContent {
  /** Shaped like crawl results, for analyseDomain's `pages`. */
  pages: CrawlResult[];
  /** Plain text of the pages, for the voice. */
  text: string;
  /** Plain text of the newest articles, for the voice. */
  articleText: string;
}

const STORE_CONTENT = `query AltoRankStoreContent {
  shop { name description }
  pages(first: 50) { nodes { title handle body bodySummary } }
  articles(first: 40, sortKey: PUBLISHED_AT, reverse: true) { nodes { title handle body summary blog { handle } } }
}`;

interface StoreContentResponse {
  shop?: { name?: string | null; description?: string | null };
  pages?: { nodes?: Array<{ title?: string; handle?: string; body?: string | null; bodySummary?: string | null }> };
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

/** Shape an Admin API answer into pages and text. Pure, for tests. */
export function storeContentFrom(domain: string, data: StoreContentResponse): StoreContent {
  const base = `https://${domain}`;
  const pages: CrawlResult[] = [];
  const texts: string[] = [];
  const articleTexts: string[] = [];

  const name = data.shop?.name?.trim() ?? "";
  const description = data.shop?.description?.trim() ?? "";
  if (name || description) {
    pages.push({ ...page(`${base}/`, name || domain, null), metaDescription: description, h1: name ? [name] : [] });
    if (description) texts.push(description);
  }
  for (const p of data.pages?.nodes ?? []) {
    if (!p.title) continue;
    pages.push(page(`${base}/pages/${p.handle ?? ""}`, p.title, p.body, p.bodySummary));
    const t = htmlToText(p.body);
    if (t) texts.push(`${p.title}\n${t}`);
  }
  // Newest first, so the voice sample is the store's current writing.
  for (const a of data.articles?.nodes ?? []) {
    if (!a.title) continue;
    pages.push(page(`${base}/blogs/${a.blog?.handle ?? ""}/${a.handle ?? ""}`, a.title, a.body, a.summary));
    const t = htmlToText(a.body);
    if (t) articleTexts.push(`${a.title}\n${t}`);
  }
  return { pages, text: texts.join("\n\n"), articleText: articleTexts.slice(0, 2).join("\n\n") };
}

/**
 * The store's content when the first look should read it this way, or null:
 * not an App Store installation, the storefront is open, or the API refused.
 */
export async function lockedStoreContent(
  supabase: SupabaseClient,
  workspaceId: string,
  domain: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<StoreContent | null> {
  // Optional by design: anything that goes wrong here leaves the first look
  // to the crawl it would have done anyway, never fails it.
  try {
    return await readLockedStoreContent(supabase, workspaceId, domain, deps);
  } catch (err) {
    console.warn(`[first-look] could not check for a locked Shopify store: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function readLockedStoreContent(
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
  const installationId = typeof config.installationId === "string" ? config.installationId : null;
  const storeUrl = typeof config.storeUrl === "string" ? config.storeUrl : null;
  if (!installationId || !storeUrl) return null;
  if (!(await storefrontLocked(domain, deps.fetchImpl))) return null;

  try {
    const data = await queryShopify<StoreContentResponse>(storeUrl, { installationId }, STORE_CONTENT);
    const content = storeContentFrom(domain, data);
    return content.pages.length ? content : null;
  } catch (err) {
    console.warn(`[first-look] could not read the store's content through Shopify: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
