// ---------------------------------------------------------------------------
// Running one refresh task: brief, rewrite, diff, park for review
// ---------------------------------------------------------------------------
//
// Called by the cron with the service role. Reads the candidate, gets the
// page's current body (our own article, or the live page for one we did not
// write), makes sure a brief exists, calls the one article generator with
// `refreshOf`, and stores what came back as an execution in `awaiting_review`.
//
// It never writes to `articles` and never talks to a CMS. Both of those are
// the push action's job, and only after a person has decided hunk by hunk.

import type { SupabaseClient } from "@supabase/supabase-js";
import { generateArticle } from "@/lib/content/generate";
import { tiptapToHtml } from "@/lib/cms/html";
import { fetchSite } from "@/lib/audit/lenient-fetch";
import { extractMainContent } from "@/lib/audit/markdown";
import { decodeEntities } from "@/lib/audit/html-utils";
import { recordSpend, anthropicCost } from "@/lib/billing/spend";
import { headingsOf } from "./detect";
import { writeBrief } from "./brief";
import { diffBlocks } from "./hunks";
import { validateRewrite } from "./validate";
import type { Evidence, ExecutionSide, Opportunity, RefreshCandidate } from "./types";

const UA = "Mozilla/5.0 (compatible; AltoRank/1.0; +https://altorank.co; content refresh)";

export interface PageBody extends ExecutionSide {
  /** Where the body came from, so the reviewer knows how much to trust the "before". */
  source: "article" | "live" | "live-heuristic";
}

function metaContent(html: string, name: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["']|` +
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`,
    "i",
  );
  const m = html.match(re);
  const v = (m?.[1] ?? m?.[2] ?? "").trim();
  return v ? decodeEntities(v) : null;
}

/**
 * The page as it is now.
 *
 * Our own article is read from its stored content, which is exactly what the
 * CMS holds if the last publish went through here. A page we did not write
 * is fetched live and its main content isolated; when the site has no
 * landmark and the extraction is a guess, the source says so.
 */
export async function loadPageBody(
  supabase: SupabaseClient,
  candidate: Pick<RefreshCandidate, "article_id" | "url" | "workspace_id">,
): Promise<PageBody> {
  if (candidate.article_id) {
    const { data: article } = await supabase
      .from("articles")
      .select("id, title, meta_description, content")
      .eq("id", candidate.article_id)
      .eq("workspace_id", candidate.workspace_id)
      .maybeSingle();
    if (article?.content) {
      return {
        html: tiptapToHtml(article.content as Record<string, unknown>),
        title: (article.title as string | null) ?? null,
        metaDescription: (article.meta_description as string | null) ?? null,
        source: "article",
      };
    }
  }

  const res = await fetchSite(candidate.url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Could not read ${candidate.url}: HTTP ${res.status}`);
  const page = await res.text();
  const main = extractMainContent(page);
  const words = main.html.replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length;
  if (words < 50) {
    throw new Error(
      `Could not read enough of ${candidate.url} to rewrite it (${words} words). The site may render in the browser only.`,
    );
  }
  const titleTag = (page.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const title = metaContent(page, "og:title") ?? (titleTag || null);
  return {
    html: main.html,
    title: title ? decodeEntities(title) : null,
    metaDescription: metaContent(page, "description") ?? metaContent(page, "og:description"),
    source: main.heuristic ? "live-heuristic" : "live",
  };
}

/**
 * The brief, written if the candidate does not have one yet.
 *
 * Stored on the candidate so the cron and the "Generate brief" button share
 * it, and so a person's edits are what the rewrite reads.
 */
export async function ensureBrief(
  supabase: SupabaseClient,
  candidate: RefreshCandidate,
  body: Pick<PageBody, "html" | "title">,
): Promise<string> {
  if (candidate.brief && candidate.brief.trim()) return candidate.brief;

  try {
    const out = await writeBrief({
      url: candidate.url,
      title: body.title,
      opportunity: candidate.opportunity as Opportunity,
      evidence: candidate.evidence as Evidence,
      headings: headingsOf(body.html),
      wordCount: (candidate.evidence as Evidence).word_count,
    });
    if (out.model && out.inputTokens !== undefined) {
      await recordSpend(supabase, {
        provider: "anthropic",
        operation: out.model,
        costUsd: anthropicCost(out.model, out.inputTokens, out.outputTokens ?? 0),
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens ?? null,
        workspaceId: candidate.workspace_id,
        articleId: candidate.article_id,
      });
    }
    await supabase
      .from("refresh_candidates")
      .update({ brief: out.text, brief_status: "ready" })
      .eq("id", candidate.id);
    return out.text;
  } catch (err) {
    await supabase
      .from("refresh_candidates")
      .update({ brief_status: "failed" })
      .eq("id", candidate.id);
    throw err;
  }
}

/** Paths this site is known to have, for the invented-link check. */
async function knownPaths(supabase: SupabaseClient, workspaceId: string): Promise<Set<string>> {
  const out = new Set<string>();
  const add = (u: string | null) => {
    if (!u) return;
    try {
      out.add(new URL(u).pathname.replace(/\/+$/, "") || "/");
    } catch {
      /* not a URL */
    }
  };
  const [{ data: pages }, { data: articles }] = await Promise.all([
    supabase.from("site_pages").select("url").eq("workspace_id", workspaceId),
    supabase.from("articles").select("published_url").eq("workspace_id", workspaceId).not("published_url", "is", null),
  ]);
  for (const p of pages ?? []) add(p.url as string);
  for (const a of articles ?? []) add(a.published_url as string);
  return out;
}

export interface RunTaskResult {
  executionId: string;
  hunks: number;
  changed: number;
  issues: number;
  wordsBefore: number;
  wordsAfter: number;
}

/**
 * Run one scheduled task end to end. Marks the task `running`, then `done`
 * with an execution or `failed` with the error. Never throws past the task
 * row: the cron reports the outcome, it does not crash on it.
 */
export async function runRefreshTask(
  supabase: SupabaseClient,
  taskId: string,
): Promise<{ ok: true; result: RunTaskResult } | { ok: false; error: string }> {
  const { data: task } = await supabase
    .from("refresh_tasks")
    .select("id, workspace_id, candidate_id, status, candidate:refresh_candidates(*)")
    .eq("id", taskId)
    .maybeSingle();
  if (!task) return { ok: false, error: "task not found" };
  if (task.status !== "scheduled") return { ok: false, error: `task is ${task.status}` };
  const candidate = task.candidate as unknown as RefreshCandidate | null;
  if (!candidate) return { ok: false, error: "candidate is gone" };
  if (candidate.dismissed_at) {
    await supabase.from("refresh_tasks").update({ status: "cancelled" }).eq("id", taskId);
    return { ok: false, error: "candidate was dismissed" };
  }

  await supabase.from("refresh_tasks").update({ status: "running" }).eq("id", taskId);

  try {
    const { data: ws } = await supabase
      .from("workspaces")
      .select("id, domain")
      .eq("id", task.workspace_id)
      .single();
    const domain = (ws?.domain as string | null) ?? null;

    const before = await loadPageBody(supabase, candidate);
    const brief = await ensureBrief(supabase, candidate, before);

    type ArticleBits = { keyword: string | null; slug: string | null };
    let article: ArticleBits | null = null;
    if (candidate.article_id) {
      const { data } = await supabase
        .from("articles")
        .select("keyword, slug")
        .eq("id", candidate.article_id)
        .eq("workspace_id", task.workspace_id)
        .maybeSingle();
      article = (data as ArticleBits | null) ?? null;
    }
    const keyword =
      (candidate.evidence as Evidence).query ??
      article?.keyword ??
      before.title ??
      candidate.url;

    const result = await generateArticle({
      supabase,
      workspaceId: task.workspace_id as string,
      keyword,
      autonomous: true,
      callerEmail: null,
      refreshOf: {
        articleId: candidate.article_id,
        url: candidate.url,
        existingHtml: before.html,
        brief,
        title: before.title,
        metaDescription: before.metaDescription,
      },
    });

    const after: ExecutionSide = {
      html: result.html,
      title: result.title,
      metaDescription: result.metaDescription || null,
    };
    const hunks = diffBlocks(before.html, after.html);
    const issues = validateRewrite(before.html, after.html, {
      siteDomain: domain,
      knownPaths: await knownPaths(supabase, task.workspace_id as string),
    });

    const { data: execution, error } = await supabase
      .from("refresh_executions")
      .insert({
        task_id: taskId,
        workspace_id: task.workspace_id,
        before: { ...before },
        after: {
          ...after,
          seoScore: result.seoScore,
          aeoScore: result.aeoScore,
          factCheck: result.factCheck.verdict,
          linkChecks: result.linkChecks,
          jobId: result.jobId,
        },
        hunks,
        validation_issues: issues,
        review_status: "awaiting_review",
        decisions: {},
      })
      .select("id")
      .single();
    if (error || !execution) throw new Error(`Could not store the rewrite: ${error?.message}`);

    await supabase.from("refresh_tasks").update({ status: "done", error: null }).eq("id", taskId);

    const words = (h: string) => h.replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length;
    return {
      ok: true,
      result: {
        executionId: execution.id as string,
        hunks: hunks.length,
        changed: hunks.filter((h) => h.kind !== "unchanged").length,
        issues: issues.length,
        wordsBefore: words(before.html),
        wordsAfter: words(after.html),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    await supabase.from("refresh_tasks").update({ status: "failed", error: message }).eq("id", taskId);
    return { ok: false, error: message };
  }
}
