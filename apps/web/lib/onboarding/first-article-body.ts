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
//
// Beside the text, how far it has got (`readFirstArticleProgress`): the
// stage, the outline's sections written and the words so far, read from the
// counts-only record the draft route keeps (migration 108). That one is
// answered with the switch off too - it is how the gate ticks the outline
// while the text stays locked - to the same person, for the same article,
// and it never selects a body column.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { tiptapToHtml } from "@/lib/cms/html";
import { readableHtml } from "./readable-html";
import { outlineHeadings, outlineOf } from "@/lib/content/outline";
import { readBodyProgress, sectionsDone } from "./body-progress";
import type { BodyStage } from "./setup-progress";

export const FULL_ARTICLE_SWITCH = "PRETRIAL_FULL_ARTICLE";

export function fullArticleOn(env: Record<string, string | undefined> = process.env): boolean {
  return env[FULL_ARTICLE_SWITCH] === "1";
}

const WRITTEN = new Set(["review", "approved", "scheduled", "live"]);

export type FirstArticleBody =
  | { ok: true; articleId: string; html: string; done: boolean; progress: FirstArticleProgress }
  | { ok: false; reason: "off" | Refusal };

/**
 * The article's HTML as the reader shows it: rebuilt from an allowlist, never
 * passed through (./readable-html.ts). Re-exported for the reader's tests.
 */
export { readableHtml };

/** Why a read of the first article was refused; the routes answer every one the same way. */
type Refusal = "not-found" | "not-owner" | "no-first-article";

/**
 * The run's first article on this site, if the person asking owns the
 * account the site is in, or why not. Every read of the first article on the
 * gate - its text, its progress - asks this first.
 */
async function ownersFirstArticle(
  client: SupabaseClient,
  userId: string,
  workspaceId: string,
  service: SupabaseClient,
): Promise<{ ok: true; articleId: string } | { ok: false; reason: Refusal }> {
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
  return { ok: true, articleId };
}

/** Postgres's "undefined column": the code is deployed and migration 108 is not. */
const UNDEFINED_COLUMN = "42703";

/**
 * The article's row with `columns`. If `body_progress` is not there yet (code
 * deployed before migration 108), the same read again without it: a missing
 * column then only loses the outline's ticks. Without this every read errored
 * into "no first article", a 404 the gate takes as a refusal, so the gate
 * never said "written" and the owner's reader never showed a word (review,
 * 2026-10-12).
 */
async function readArticleRow(service: SupabaseClient, id: string, workspaceId: string, columns: string): Promise<unknown> {
  const read = (cols: string) => service.from("articles").select(cols).eq("id", id).eq("workspace_id", workspaceId).maybeSingle();
  const { data, error } = await read(columns);
  if (error?.code === UNDEFINED_COLUMN && columns.includes("body_progress")) {
    const again = await read(columns.replace(/,\s*body_progress/, ""));
    return again.data ? { ...(again.data as unknown as Record<string, unknown>), body_progress: null } : null;
  }
  return data;
}

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
  const service = opts.service ?? createServiceClient();
  const owned = await ownersFirstArticle(client, userId, workspaceId, service);
  if (!owned.ok) return owned;
  const articleId = owned.articleId;
  const row = await readArticleRow(service, articleId, workspaceId, "id, status, word_count, content, body_stream, body_progress, instructions_snapshot");
  const article = row as { id: string; status: string; word_count: number | null; content: unknown; body_stream: string | null; body_progress: unknown; instructions_snapshot: unknown } | null;
  if (!article) return { ok: false, reason: "no-first-article" };
  const done = WRITTEN.has(article.status) && article.content !== null;
  const html = done
    ? readableHtml(typeof article.content === "string" ? article.content : tiptapToHtml(article.content as Record<string, unknown>))
    : readableHtml(article.body_stream ?? "");
  return { ok: true, articleId, html, done, progress: progressOf(article, done) };
}

// ---------------------------------------------------------------------------
// Progress without the text, whatever the switch says
// ---------------------------------------------------------------------------

/** How far the first article's body has got. Counts, a stage and a time: never text. */
export interface FirstArticleProgress {
  done: boolean;
  /** Null before the writer's first record (or once the body is saved). */
  stage: BodyStage | null;
  /** Milliseconds the body has been in `stage`. */
  stageMs: number;
  /** Indexes of the outline's headings (closing included) that are written. */
  sectionsDone: number[];
  /** The outline's headings, closing included: what `sectionsDone` counts out of. */
  sections: number;
  /** Words of body text so far; the saved count once done. */
  words: number;
}

export type FirstArticleProgressRead =
  | ({ ok: true; articleId: string } & FirstArticleProgress)
  | { ok: false; reason: Refusal };

function progressOf(
  article: { status: string; body_progress: unknown; instructions_snapshot: unknown; word_count?: number | null },
  done: boolean,
  now: number = Date.now(),
): FirstArticleProgress {
  const outline = outlineOf(article.instructions_snapshot);
  const total = outline ? outlineHeadings(outline).length : 0;
  const progress = done ? null : readBodyProgress(article.body_progress);
  const since = progress ? Date.parse(progress.since) : NaN;
  return {
    done,
    stage: progress?.stage ?? null,
    stageMs: Number.isFinite(since) ? Math.max(0, now - since) : 0,
    sectionsDone: sectionsDone(progress, total, { done, hasClosing: Boolean(outline?.closing) }),
    sections: total,
    words: done ? Math.max(0, article.word_count ?? 0) : progress?.words ?? 0,
  };
}

/**
 * How far the owner's first article has got, for the gate's outline - with
 * the switch on or off, because it carries no text: the columns read are the
 * status, the word count, the outline and the counts-only record (108). The
 * body columns are never selected here. Same refusals as the text.
 */
export async function readFirstArticleProgress(
  client: SupabaseClient,
  userId: string,
  workspaceId: string,
  opts: { service?: SupabaseClient; now?: number } = {},
): Promise<FirstArticleProgressRead> {
  const service = opts.service ?? createServiceClient();
  const owned = await ownersFirstArticle(client, userId, workspaceId, service);
  if (!owned.ok) return owned;
  const row = await readArticleRow(service, owned.articleId, workspaceId, "id, status, word_count, body_progress, instructions_snapshot");
  const article = row as { id: string; status: string; word_count: number | null; body_progress: unknown; instructions_snapshot: unknown } | null;
  if (!article) return { ok: false, reason: "no-first-article" };
  const done = WRITTEN.has(article.status) && (article.word_count ?? 0) > 0;
  return { ok: true, articleId: owned.articleId, ...progressOf(article, done, opts.now) };
}
