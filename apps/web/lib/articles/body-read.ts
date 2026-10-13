// ---------------------------------------------------------------------------
// Reading an article's body: on the server, never through a client token
// ---------------------------------------------------------------------------
//
// Migration 097 takes the body columns away from `anon` and `authenticated`.
// Until then the database handed `articles.content` to any member through
// PostgREST: the session cookie is readable from the page and the anon key
// is public, so anyone signed in could ask /rest/v1/articles for the text
// directly and skip every check the app made. A lock the app applies after
// the read is not a lock on the read.
//
// So the text leaves the database only here, with the service role, for a
// caller whose own client has just said it may see the row. The caller's
// client still answers WHICH rows (RLS, the account and site boundaries);
// this answers only with WHAT is in them. Whether the caller may be handed
// the text is the trial gate's decision (lib/billing/body-lock.ts), made on
// the server and nowhere else.
//
// A read through a client token that names a body column, or `*`, now fails
// with "permission denied for table articles". That is the intended failure:
// loud, where a new read path would otherwise have been a new leak.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Every article column that carries the article's words or quotes them.
 *
 * `content` is the text itself. `meta_description` is written by the model
 * from it. `fact_checks` stores each checked sentence whole, `link_checks`
 * and `seo_checks`/`aeo_checks` carry anchors and notes lifted from it. What
 * stays readable to a client token is what the gate card may show: title,
 * keyword, length, status, scores.
 *
 * Migration 097 withholds exactly these from `anon` and `authenticated`.
 * Change the two together.
 */
export const ARTICLE_BODY_COLUMNS = [
  "content",
  "meta_description",
  "fact_checks",
  "link_checks",
  "seo_checks",
  "aeo_checks",
] as const;

/** Ids per request: a uuid list in the query string, well under any URL limit. */
const CHUNK = 100;

/**
 * Article rows read whole, by id, with the service role.
 *
 * Only for ids the caller's own client has already returned: this bypasses
 * RLS, so the ids are the permission. Rows come back in the order the ids
 * were given; an id with no row is dropped.
 */
export async function readArticlesWhole<T = Record<string, unknown>>(
  ids: readonly string[],
  columns: string = "*",
): Promise<T[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const service = createServiceClient();
  // `id` always, so the rows can be put back in the caller's order.
  const named = columns.split(",").map((c) => c.trim());
  const select = named.includes("*") || named.includes("id") ? columns : `id, ${columns}`;
  const byId = new Map<string, T>();
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const { data, error } = await service.from("articles").select(select).in("id", chunk);
    if (error) throw new Error(`article read: could not read the articles (${error.message})`);
    for (const row of (data ?? []) as unknown as (T & { id: string })[]) byId.set(row.id, row);
  }
  return ids.map((id) => byId.get(id)).filter((r): r is T => r !== undefined);
}

/**
 * One article, whole, for a caller whose own client can see it.
 *
 * Visibility is asked through `client`: RLS for a person, everything for a
 * cron's service client. Only then is the row read with the service role.
 * Null when the caller cannot see it. No trial gate here: the publishing
 * core calls this, and every door into publishing already asks for a plan.
 */
export async function readVisibleArticle<T = Record<string, unknown>>(
  client: SupabaseClient,
  articleId: string,
  columns: string = "*",
): Promise<T | null> {
  const { data: seen, error } = await client.from("articles").select("id").eq("id", articleId).maybeSingle();
  // Not knowing whether the caller may see it is not permission to read it.
  if (error) throw new Error(`article read: could not check the article (${error.message})`);
  if (!seen) return null;
  const [row] = await readArticlesWhole<T>([articleId], columns);
  return row ?? null;
}
