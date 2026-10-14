// ---------------------------------------------------------------------------
// The first article's full text on the gate, behind a switch
// ---------------------------------------------------------------------------
//
// PRETRIAL_FULL_ARTICLE=1 lets an account's owner read their own first
// article in full on the gate screen before the trial - streamed in while it
// is written, read-only. Off by default: the gate then shows the shape only,
// as it has since a real signup copied a whole draft off a preview page and
// published it within the hour (2026-09-22). Publishing, editing, more
// articles and the dashboard stay behind the trial either way.
//
// Migration 097 keeps the text from every client token; this does not change
// that. The text leaves the database here, on the service role, only after
// every one of these has answered yes:
//
//   the switch     PRETRIAL_FULL_ARTICLE is "1"
//   the person     signed in, and the OWNER of the account the site is in -
//                  asked through their own client, so RLS decides whether
//                  they can see the site at all
//   the article    the one the site's latest onboarding run points at, and
//                  the site's first article (its oldest that is not errored)
//
// Anything else - another account, another article, a member who is not the
// owner, the switch off - is refused with nothing read.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { tiptapToHtml } from "@/lib/cms/html";
import { readableHtml } from "./readable-html";

export const FULL_ARTICLE_SWITCH = "PRETRIAL_FULL_ARTICLE";

export function fullArticleOn(env: Record<string, string | undefined> = process.env): boolean {
  return env[FULL_ARTICLE_SWITCH] === "1";
}

const WRITTEN = new Set(["review", "approved", "scheduled", "live"]);

export type FirstArticleBody =
  | { ok: true; articleId: string; html: string; done: boolean }
  | { ok: false; reason: "off" | "not-found" | "not-owner" | "no-first-article" };

/**
 * The article's HTML as the reader shows it: rebuilt from an allowlist, never
 * passed through (./readable-html.ts). Re-exported for the reader's tests.
 */
export { readableHtml };

/**
 * The first article's body for the person asking, or why not. `client` is
 * the person's own (cookie) client; `userId` is who it is signed in as.
 */
export async function readFirstArticleBody(
  client: SupabaseClient,
  userId: string,
  workspaceId: string,
  opts: { env?: Record<string, string | undefined>; service?: SupabaseClient } = {},
): Promise<FirstArticleBody> {
  if (!fullArticleOn(opts.env)) return { ok: false, reason: "off" };
  // Through the person's client: RLS answers whether they can see the site.
  const { data: site } = await client.from("workspaces").select("id, account_id").eq("id", workspaceId).maybeSingle();
  if (!site) return { ok: false, reason: "not-found" };
  const { data: member } = await client
    .from("account_members")
    .select("role")
    .eq("account_id", site.account_id)
    .eq("user_id", userId)
    .maybeSingle();
  if ((member as { role?: string } | null)?.role !== "owner") return { ok: false, reason: "not-owner" };
  const { data: run } = await client
    .from("onboarding_runs")
    .select("article_id")
    .eq("workspace_id", workspaceId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const articleId = (run as { article_id?: string | null } | null)?.article_id ?? null;
  if (!articleId) return { ok: false, reason: "no-first-article" };
  const service = opts.service ?? createServiceClient();
  // The site's first article, and the run's: the oldest that is not errored.
  const { data: first } = await service
    .from("articles")
    .select("id")
    .eq("workspace_id", workspaceId)
    .neq("status", "error")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if ((first as { id?: string } | null)?.id !== articleId) return { ok: false, reason: "no-first-article" };
  const { data: row } = await service
    .from("articles")
    .select("id, status, content, body_stream")
    .eq("id", articleId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const article = row as { id: string; status: string; content: unknown; body_stream: string | null } | null;
  if (!article) return { ok: false, reason: "no-first-article" };
  const done = WRITTEN.has(article.status) && article.content !== null;
  const html = done
    ? readableHtml(typeof article.content === "string" ? article.content : tiptapToHtml(article.content as Record<string, unknown>))
    : readableHtml(article.body_stream ?? "");
  return { ok: true, articleId, html, done };
}
