import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * `base`, or `base-2`, `base-3`... whichever no article on the site already
 * has.
 *
 * Nothing in the schema makes a slug unique per site, and two articles from
 * one keyword or title used to get the same one. A site reading the blog API
 * (@altorank/next-blog) serves articles by slug, so two live rows with one
 * slug meant one of them could never be reached and the detail route failed
 * the site's build. A CMS that dedupes on its side (WordPress does) is not
 * affected either way.
 *
 * Best effort: a failed read keeps `base`, the way creation worked before.
 * Two creations racing can still pick the same slug; the blog route serves
 * the newest of them rather than failing.
 */
export async function uniqueSlug(supabase: SupabaseClient, workspaceId: string, base: string): Promise<string> {
  if (!base) return base;
  try {
    const pattern = `${base.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const { data, error } = await supabase
      .from("articles")
      .select("slug")
      .eq("workspace_id", workspaceId)
      .ilike("slug", pattern);
    if (error || !data) return base;
    const taken = new Set((data as { slug: string | null }[]).map((r) => (r.slug ?? "").toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  } catch {
    return base;
  }
}
