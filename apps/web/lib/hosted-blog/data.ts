import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { appUrl } from "@/lib/app-url";
import { accountTrialGate } from "@/lib/billing/body-lock";

// ---------------------------------------------------------------------------
// The hosted blog's reads (migration 120)
// ---------------------------------------------------------------------------
//
// A site's live articles at app.altorank.co/b/<slug>, and later at its own
// blog.<domain>. The pages are public, so every read goes through the service
// client in a narrow query: only the columns a reader sees, never the row.
//
// What is shown is exactly what the blog API serves (app/api/blog/v1/articles):
// `status = 'live'`, minus an article the nightly check found live on the
// customer's own site. That one is already at the address they published it
// at by hand; a second copy here would compete with it. And, as there, an
// account the trial gate holds serves nothing: the gate withholds article
// text until a card is in, and a public page is the easiest place to copy it.

export const HOSTED_BLOG_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const PER_PAGE = 12;

export type HostedBlogStatus = "off" | "preview" | "pending_dns" | "verified";

export type HostedSite = {
  id: string;
  slug: string;
  host: string | null;
  status: Exclude<HostedBlogStatus, "off">;
  domain: string;
  name: string;
  language: string | null;
  /** A #rrggbb from the site's settings, or null for the app's ink. */
  accent: string | null;
};

export type HostedArticleSummary = {
  id: string;
  slug: string;
  title: string;
  meta_description: string | null;
  featured_image_url: string | null;
  published_at: string | null;
  updated_at: string;
};

export type HostedArticle = HostedArticleSummary & {
  keyword: string | null;
  content: Record<string, unknown> | null;
};

const SITE_COLUMNS =
  "id, account_id, domain, language, brand_style, hosted_blog_slug, hosted_blog_host, hosted_blog_status, profile_name:business_profile->>name";
const SUMMARY_COLUMNS = "id, slug, title, meta_description, featured_image_url, published_at, updated_at";
const ARTICLE_COLUMNS = `${SUMMARY_COLUMNS}, keyword, content`;

type SiteRow = {
  id: string;
  account_id: string;
  domain: string | null;
  language: string | null;
  brand_style: Record<string, unknown> | null;
  hosted_blog_slug: string | null;
  hosted_blog_host: string | null;
  hosted_blog_status: HostedBlogStatus | null;
  profile_name: string | null;
};

const HEX = /^#[0-9a-f]{6}$/i;

/** The settings' brand colour wins over a colour named in the free-form brand_style, as for images. */
export function accentFrom(brandColor: unknown, brandStyle: Record<string, unknown> | null): string | null {
  if (typeof brandColor === "string" && HEX.test(brandColor.trim())) return brandColor.trim().toLowerCase();
  const colors = brandStyle?.colors;
  const first = Array.isArray(colors) ? colors[0] : typeof colors === "string" ? colors.match(/#[0-9a-f]{6}/i)?.[0] : null;
  return typeof first === "string" && HEX.test(first) ? first.toLowerCase() : null;
}

/**
 * The site behind a slug, or null when there is none or its blog is off:
 * the page 404s either way, so an unknown slug, a switched-off blog and an
 * account behind the trial gate cannot be told apart from outside.
 */
export async function getHostedSite(
  slug: string,
  supabase: SupabaseClient = createServiceClient(),
): Promise<HostedSite | null> {
  if (!HOSTED_BLOG_SLUG.test(slug)) return null;
  const { data, error } = await supabase
    .from("workspaces")
    .select(SITE_COLUMNS)
    .eq("hosted_blog_slug", slug)
    .neq("hosted_blog_status", "off")
    .maybeSingle();
  if (error) throw new Error(`hosted blog: could not read the site (${error.message})`);
  const row = data as SiteRow | null;
  if (!row || !row.hosted_blog_status || row.hosted_blog_status === "off") return null;
  if ((await accountTrialGate(supabase, row.account_id, null)) === "gated") return null;

  const { data: settings } = await supabase
    .from("workspace_output_settings")
    .select("brand_color")
    .eq("workspace_id", row.id)
    .maybeSingle();

  const domain = String(row.domain ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return {
    id: row.id,
    slug,
    host: row.hosted_blog_host,
    status: row.hosted_blog_status,
    domain,
    name: row.profile_name?.trim() || domain,
    language: row.language,
    accent: accentFrom(settings?.brand_color, row.brand_style),
  };
}

/** One page of live articles, newest first, with the total for the pager. */
export async function listHostedArticles(
  siteId: string,
  page: number,
  supabase: SupabaseClient = createServiceClient(),
  perPage = PER_PAGE,
): Promise<{ articles: HostedArticleSummary[]; total: number }> {
  const from = (Math.max(1, page) - 1) * perPage;
  const { data, error, count } = await supabase
    .from("articles")
    .select(SUMMARY_COLUMNS, { count: "exact" })
    .eq("workspace_id", siteId)
    .eq("status", "live")
    .is("found_on_site_at", null)
    .order("published_at", { ascending: false, nullsFirst: false })
    .range(from, from + perPage - 1);
  // A page past the last is PostgREST's PGRST103, not an empty list: the
  // index turns it into a 404.
  if (error?.code === "PGRST103") return { articles: [], total: 0 };
  if (error) throw new Error(`hosted blog: could not list the articles (${error.message})`);
  return { articles: (data ?? []) as HostedArticleSummary[], total: count ?? 0 };
}

/** One live article by its slug; the most recently published wins a shared slug, as in the blog API. */
export async function getHostedArticle(
  siteId: string,
  articleSlug: string,
  supabase: SupabaseClient = createServiceClient(),
): Promise<HostedArticle | null> {
  const { data, error } = await supabase
    .from("articles")
    .select(ARTICLE_COLUMNS)
    .eq("workspace_id", siteId)
    .eq("status", "live")
    .is("found_on_site_at", null)
    .eq("slug", articleSlug)
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`hosted blog: could not read the article (${error.message})`);
  return (data as HostedArticle | null) ?? null;
}

/**
 * Where the blog's pages live, for links and for the canonical.
 *
 * `canonicalRoot` is the customer's host once it is verified, else the
 * preview URL. `linkRoot` is the path the reader's own links use: on the
 * customer's host (once it is rewritten to these routes) the blog sits at `/`,
 * everywhere else at `/b/<slug>`. Only a request on the verified host is
 * indexable; the preview path is always noindex.
 */
export function hostedBlogUrls(site: Pick<HostedSite, "slug" | "host" | "status">, requestHost: string | null) {
  const verifiedHost = site.status === "verified" && site.host ? site.host : null;
  const onOwnHost = Boolean(verifiedHost && requestHost && requestHost.toLowerCase().split(":")[0] === verifiedHost);
  const previewRoot = `${appUrl()}/b/${site.slug}`;
  return {
    canonicalRoot: verifiedHost ? `https://${verifiedHost}` : previewRoot,
    linkRoot: onOwnHost ? "" : `/b/${site.slug}`,
    indexable: onOwnHost,
  };
}
