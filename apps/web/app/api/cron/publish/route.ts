import { NextResponse } from "next/server";
import { cronSecretFrom } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { publishArticleCore } from "@/lib/publishing/core";
import { isCadenceDue, cadenceLocalDate, withoutPaused } from "@/lib/publishing/cadence";
import type { PublishingCadence } from "@/lib/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { urlIsLive, deriveBlogBaseUrl } from "@/lib/cms/blog-url";
import { submitForIndexing, type IndexingResult } from "@/lib/seo/indexing";

export const maxDuration = 60;

type Result = {
  articleId: string;
  workspaceId: string;
  status: "success" | "error";
  error?: string;
};

export async function GET(request: Request) {
  const cronSecret = cronSecretFrom(request);
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const now = new Date();
  const results: Result[] = [];

  // A paused site publishes nothing, however it was paused (by hand from the
  // switcher, or account-wide from Billing). The other crons filter on the
  // workspace row; here the queue is articles and cadences, so the paused set
  // is read once and both phases skip it. A read failure is a failure: an
  // empty set would mean "nothing is paused", and publishing to a paused
  // client's site is exactly the mistake this exists to prevent.
  const { data: pausedRows, error: pausedError } = await supabase
    .from("workspaces")
    .select("id")
    .eq("status", "paused");
  if (pausedError) {
    return NextResponse.json({ error: pausedError.message }, { status: 500 });
  }
  const pausedWorkspaceIds = new Set((pausedRows ?? []).map((w) => w.id as string));

  // ── Phase 1: per-article overrides (scheduled_at <= now) ──
  const { data: overrideArticles, error: overrideError } = await supabase
    .from("articles")
    .select("id, workspace_id")
    .eq("status", "scheduled")
    .not("scheduled_at", "is", null)
    .lte("scheduled_at", now.toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(20);

  // Publishing is the one cron whose "nothing to do" is indistinguishable from
  // "the queue could not be read", and the cost of getting that wrong is a
  // scheduled article that silently never ships.
  if (overrideError) {
    return NextResponse.json({ error: overrideError.message }, { status: 500 });
  }

  for (const article of withoutPaused(overrideArticles ?? [], pausedWorkspaceIds)) {
    try {
      await publishArticleCore(supabase, article.id);
      await supabase.from("publish_log").insert({
        article_id: article.id,
        workspace_id: article.workspace_id,
        status: "success",
        triggered_by: "cron",
      });
      results.push({
        articleId: article.id,
        workspaceId: article.workspace_id,
        status: "success",
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      await supabase
        .from("articles")
        .update({ status: "error", updated_at: now.toISOString() })
        .eq("id", article.id);
      await supabase.from("publish_log").insert({
        article_id: article.id,
        workspace_id: article.workspace_id,
        status: "error",
        error: errorMsg,
        triggered_by: "cron",
      });
      results.push({
        articleId: article.id,
        workspaceId: article.workspace_id,
        status: "error",
        error: errorMsg,
      });
    }
  }

  // ── Phase 2: workspace cadence (scheduled_at IS NULL) ──
  const { data: cadences, error: cadenceError } = await supabase
    .from("publishing_cadences")
    .select("*")
    .eq("enabled", true);

  if (cadenceError) {
    return NextResponse.json({ error: cadenceError.message }, { status: 500 });
  }

  for (const cadence of withoutPaused((cadences ?? []) as PublishingCadence[], pausedWorkspaceIds)) {
    // "Already published today" is what keeps this idempotent now that the
    // window is gone. Without it a cron running more than once a day would
    // publish the whole queue in a single day. publish_log already records
    // every cron publish, so the check costs one indexed lookup per cadence.
    const { data: lastPublish } = await supabase
      .from("publish_log")
      .select("created_at")
      .eq("workspace_id", cadence.workspace_id)
      .eq("status", "success")
      .order("created_at", { ascending: false })
      .limit(1);

    const lastLocalDate = lastPublish?.[0]?.created_at
      ? cadenceLocalDate(cadence.timezone, new Date(lastPublish[0].created_at))
      : null;

    if (!isCadenceDue(cadence, now, lastLocalDate)) continue;

    // Find oldest scheduled article without a specific scheduled_at
    const { data: queueArticles, error: queueError } = await supabase
      .from("articles")
      .select("id, workspace_id")
      .eq("workspace_id", cadence.workspace_id)
      .eq("status", "scheduled")
      .is("scheduled_at", null)
      .order("created_at", { ascending: true })
      .limit(1);

    // One workspace's unreadable queue should not abort the other workspaces'
    // slots, but it must not read as an empty queue either.
    if (queueError) {
      results.push({
        articleId: "",
        workspaceId: cadence.workspace_id,
        status: "error",
        error: `queue lookup: ${queueError.message}`,
      });
      continue;
    }

    const article = queueArticles?.[0];
    if (!article) continue;

    try {
      await publishArticleCore(supabase, article.id);
      await supabase.from("publish_log").insert({
        article_id: article.id,
        workspace_id: article.workspace_id,
        status: "success",
        triggered_by: "cron",
      });
      results.push({
        articleId: article.id,
        workspaceId: article.workspace_id,
        status: "success",
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      await supabase
        .from("articles")
        .update({ status: "error", updated_at: now.toISOString() })
        .eq("id", article.id);
      await supabase.from("publish_log").insert({
        article_id: article.id,
        workspace_id: article.workspace_id,
        status: "error",
        error: errorMsg,
        triggered_by: "cron",
      });
      results.push({
        articleId: article.id,
        workspaceId: article.workspace_id,
        status: "error",
        error: errorMsg,
      });
    }
  }

  // ── Phase 3: confirm git publishes that a build has had time to deploy ──
  //
  // Only git reaches here. Every other adapter returns a URL its own API has
  // already confirmed; a commit returns a prediction. Until that prediction
  // resolves, nothing is submitted to IndexNow and the article does not claim a
  // URL it cannot back up.
  //
  // The budget is deliberately generous. A queued Netlify or Vercel build can
  // sit for minutes, and a wrongly-abandoned article costs more than a few
  // extra HEADs: the content is committed either way, so the only thing at
  // stake is whether we can point at it.
  const verified = await verifyPendingPublishes(supabase, now);

  const published = results.filter((r) => r.status === "success").length;
  const errors = results.filter((r) => r.status === "error").length;

  return NextResponse.json({
    success: true,
    published,
    errors,
    verified,
    results,
  });
}

/** Passes before a pending URL is called unconfirmed. At a 15-minute cron, ~2 hours. */
const MAX_VERIFY_ATTEMPTS = 8;

/** Attempt at which a still-404 URL is treated as a wrong convention, not a slow build. */
const REDERIVE_AT_ATTEMPT = 4;

type PendingArticle = {
  id: string;
  workspace_id: string;
  slug: string;
  published_url: string | null;
  indexing_status: IndexingResult | null;
};

async function verifyPendingPublishes(
  supabase: SupabaseClient,
  now: Date,
): Promise<{ confirmed: number; stillPending: number; unconfirmed: number }> {
  const out = { confirmed: 0, stillPending: 0, unconfirmed: 0 };

  const { data: pending } = await supabase
    .from("articles")
    .select("id, workspace_id, slug, published_url, indexing_status")
    .eq("status", "live")
    .eq("indexing_status->>urlVerified", "pending")
    .limit(50);

  for (const article of (pending ?? []) as PendingArticle[]) {
    const attempts = (article.indexing_status?.attempts ?? 0) + 1;
    let url = article.published_url;
    if (!url) continue;

    let live = await urlIsLive(url);

    /**
     * A URL that is still missing after several passes is usually not a slow
     * build - it is the wrong prefix. By now the build has almost certainly
     * run, so the site's sitemap may list the post under its real path. Re-read
     * it once and try that before giving up.
     */
    if (!live && attempts === REDERIVE_AT_ATTEMPT) {
      const derived = await deriveBlogBaseUrl(url);
      if (derived) {
        const retry = `${derived.baseUrl}/${article.slug}${derived.trailingSlash ? "/" : ""}`;
        if (retry !== url && (await urlIsLive(retry))) {
          url = retry;
          live = true;
        }
      }
    }

    if (live) {
      const { data: ws } = await supabase
        .from("workspaces")
        .select("indexnow_key")
        .eq("id", article.workspace_id)
        .single();

      const indexing = await submitForIndexing({
        url,
        indexNowKey: ws?.indexnow_key ?? null,
        gscToken: null,
      });

      await supabase
        .from("articles")
        .update({
          published_url: url,
          indexing_status: { ...indexing, urlVerified: "confirmed", attempts },
          updated_at: now.toISOString(),
        })
        .eq("id", article.id);
      out.confirmed++;
      continue;
    }

    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      /**
       * Never confirmed. The commit succeeded and the Markdown is in the repo,
       * so the content is not lost - but we cannot say where it is, and an
       * agency showing a client a link that 404s is worse than showing none.
       * Back to review, with the URL cleared rather than left as a bad claim.
       */
      await supabase
        .from("articles")
        .update({
          status: "review",
          published_url: null,
          indexing_status: {
            indexnow: "awaiting-build",
            google: "awaiting-build",
            urlVerified: "unconfirmed",
            attempts,
          } satisfies IndexingResult,
          updated_at: now.toISOString(),
        })
        .eq("id", article.id);

      await supabase.from("publish_log").insert({
        article_id: article.id,
        workspace_id: article.workspace_id,
        status: "error",
        error:
          "Committed to the repo, but the published URL never resolved. " +
          "Check the site built, and that the blog URL on the connection is right.",
        triggered_by: "cron",
      });
      out.unconfirmed++;
      continue;
    }

    await supabase
      .from("articles")
      .update({
        indexing_status: { ...(article.indexing_status ?? {}), attempts },
      })
      .eq("id", article.id);
    out.stillPending++;
  }

  return out;
}
