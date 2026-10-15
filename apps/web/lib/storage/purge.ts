import type { SupabaseClient } from "@supabase/supabase-js";
import { REPORTS_BUCKET } from "@/lib/reports/storage";

// ---------------------------------------------------------------------------
// Removing what a deleted article or site left in storage
// ---------------------------------------------------------------------------
//
// A row's foreign-key cascade does not reach `storage.objects`, so deleting a
// site used to leave its monthly report PDFs in the `reports` bucket (where a
// link signed for the email kept serving them for up to 30 days), and
// deleting an article or a site left its draft images and uploaded proposals
// in `article-images`.
//
// Images of an article that ever reached a reader are kept: a published post,
// a CMS draft and a page found live on the customer's site all hotlink them,
// and the delete card promises nothing already published is touched. Images
// of an article that never did are removed with it.
//
// Every call takes the service-role client (lib/storage/admin.ts), after the
// caller has checked the person may delete the row (the RLS delete itself
// succeeded). No server-only import here: lib/workspaces/delete.ts, which a
// client component reads its confirmation text from, imports this file.

export const ARTICLE_IMAGES_BUCKET = "article-images";

const PAGE = 1000;
const REMOVE_BATCH = 500;

/** The columns that say whether an article ever reached a reader. */
export const LIVE_COLUMNS = "id, status, published_url, published_at, external_id, found_on_site_at";

export type LiveFacts = {
  status?: string | null;
  published_url?: string | null;
  published_at?: string | null;
  external_id?: string | null;
  found_on_site_at?: string | null;
};

/** Published by us, sent to a CMS (even as a draft there), or found live on the site. */
export function wasEverLive(a: LiveFacts): boolean {
  return (
    a.status === "live" ||
    Boolean(a.published_url) ||
    Boolean(a.published_at) ||
    Boolean(a.external_id) ||
    Boolean(a.found_on_site_at)
  );
}

const ARTICLE_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[.\-/]|$)/i;

/**
 * The article an object under `<workspace>/` belongs to:
 * `<article>.<ext>` (featured), `<article>-<n>.<ext>` (in-body) or the
 * `<article>` folder (`proposals/` inside it).
 */
export function articleOfImage(name: string): string | null {
  const m = name.match(ARTICLE_ID);
  return m ? m[1].toLowerCase() : null;
}

type Entry = { name: string; id: string | null };

async function listAll(storage: SupabaseClient, bucket: string, prefix: string): Promise<Entry[]> {
  const out: Entry[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await storage.storage
      .from(bucket)
      .list(prefix, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`Could not list ${bucket}/${prefix}: ${error.message}`);
    const page = (data ?? []) as Entry[];
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

/** Every file under `prefix`, descending `depth` folder levels (proposals/ is the only one). */
async function filesUnder(storage: SupabaseClient, bucket: string, prefix: string, depth = 2): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await listAll(storage, bucket, prefix)) {
    const path = `${prefix}/${entry.name}`;
    // A folder comes back with no id.
    if (entry.id === null) {
      if (depth > 0) paths.push(...(await filesUnder(storage, bucket, path, depth - 1)));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

async function removeAll(storage: SupabaseClient, bucket: string, paths: string[]): Promise<number> {
  for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
    const { error } = await storage.storage.from(bucket).remove(paths.slice(i, i + REMOVE_BATCH));
    if (error) throw new Error(`Could not remove from ${bucket}: ${error.message}`);
  }
  return paths.length;
}

/** Remove the images and proposals of these articles of one site. Returns how many files went. */
export async function purgeArticleImages(
  storage: SupabaseClient,
  workspaceId: string,
  articleIds: readonly string[],
): Promise<number> {
  const ids = new Set(articleIds.map((id) => id.toLowerCase()));
  if (ids.size === 0) return 0;
  // The site's folder, matched here by name: the listing's own search
  // semantics are not something to delete files by.
  const paths: string[] = [];
  for (const entry of await listAll(storage, ARTICLE_IMAGES_BUCKET, workspaceId)) {
    const owner = articleOfImage(entry.name);
    if (!owner || !ids.has(owner)) continue;
    const path = `${workspaceId}/${entry.name}`;
    if (entry.id === null) paths.push(...(await filesUnder(storage, ARTICLE_IMAGES_BUCKET, path)));
    else paths.push(path);
  }
  return removeAll(storage, ARTICLE_IMAGES_BUCKET, paths);
}

/** Remove every report PDF of one site (`reports/<workspace>/…`, lib/reports/storage.ts). */
export async function purgeWorkspaceReports(storage: SupabaseClient, workspaceId: string): Promise<number> {
  return removeAll(storage, REPORTS_BUCKET, await filesUnder(storage, REPORTS_BUCKET, `reports/${workspaceId}`, 0));
}

/** The site's articles that never reached a reader, read in pages. */
export async function neverLiveArticleIds(storage: SupabaseClient, workspaceId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await storage
      .from("articles")
      .select(LIVE_COLUMNS)
      .eq("workspace_id", workspaceId)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read the site's articles: ${error.message}`);
    const page = (data ?? []) as unknown as (LiveFacts & { id: string })[];
    for (const a of page) if (!wasEverLive(a)) ids.push(a.id);
    if (page.length < PAGE) return ids;
  }
}
