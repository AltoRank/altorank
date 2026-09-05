"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { discoverKeywords } from "@/lib/seo/keywords";
import { checkRankings } from "@/lib/seo/serp";
import { syncBacklinks } from "@/lib/seo/backlinks";
import { scoreArticle } from "@/lib/seo/scoring";
import type { Workspace, Keyword, Article } from "@/lib/types";
import { buildRankingRows } from "@/lib/seo/rankings";

// ---------------------------------------------------------------------------
// runKeywordResearch
// ---------------------------------------------------------------------------

export async function runKeywordResearch(workspaceId: string) {
  const supabase = await createClient();

  // Fetch workspace to get domain
  const { data: workspace, error: wsError } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", workspaceId)
    .single();

  if (wsError || !workspace) {
    throw new Error("Workspace not found");
  }

  const ws = workspace as Workspace;
  if (!ws.domain) {
    throw new Error("Workspace has no domain configured");
  }

  // Call DataForSEO with workspace locale
  // withDifficulty matches what cron/analyze already requests. This path ran
  // without it, which is why a fresh onboarding produced 1,000 keywords with
  // 1,000 null difficulties while the cron's discoveries had numbers: two
  // callers of one function, drifted by a flag.
  const keywords = await discoverKeywords(ws.domain, {
    languageCode: ws.language ?? "en",
    locationCode: ws.location_code ?? 2840,
    withDifficulty: true,
  });

  // Upsert into keywords table. Provenance is stamped on new rows only: a
  // re-run refreshes volume and difficulty on rows that exist but must not
  // relabel a competitor's keyword as an ads one.
  const { data: known } = await supabase
    .from("keywords")
    .select("term")
    .eq("workspace_id", workspaceId);
  const knownTerms = new Set((known ?? []).map((k) => (k.term as string).toLowerCase()));
  const rows = keywords.map((kw) => ({
    workspace_id: workspaceId,
    term: kw.keyword,
    volume: kw.volume,
    difficulty: kw.difficulty,
    intent: kw.intent,
    status: "new" as const,
    // keywords_for_site is the ads endpoint; say so, so the rollup can.
    ...(knownTerms.has(kw.keyword.toLowerCase()) ? {} : { source_type: "ads" as const }),
  }));

  if (rows.length > 0) {
    const { error: upsertError } = await supabase
      .from("keywords")
      .upsert(rows, { onConflict: "workspace_id,term", ignoreDuplicates: false });

    if (upsertError) {
      throw new Error(`Failed to upsert keywords: ${upsertError.message}`);
    }
  }

  revalidatePath("/keywords");

  return { discovered: keywords.length };
}

// ---------------------------------------------------------------------------
// checkSerpPositions
// ---------------------------------------------------------------------------

export async function checkSerpPositions(workspaceId: string) {
  const supabase = await createClient();

  // Fetch workspace domain
  const { data: workspace, error: wsError } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", workspaceId)
    .single();

  if (wsError || !workspace) {
    throw new Error("Workspace not found");
  }

  const ws = workspace as Workspace;
  if (!ws.domain) {
    throw new Error("Workspace has no domain configured");
  }

  // Fetch all keywords for workspace
  const { data: keywordsData, error: kwError } = await supabase
    .from("keywords")
    .select("*")
    .eq("workspace_id", workspaceId);

  if (kwError) {
    throw new Error(`Failed to fetch keywords: ${kwError.message}`);
  }

  const keywords = (keywordsData ?? []) as Keyword[];
  if (keywords.length === 0) return { checked: 0 };

  const terms = keywords.map((k) => k.term);

  // Call DataForSEO SERP check with workspace locale
  const rankings = await checkRankings(terms, ws.domain, {
    languageCode: ws.language ?? "en",
    locationCode: ws.location_code ?? 2840,
  });

  // Build a map of term -> keyword id
  const termToId = new Map(keywords.map((k) => [k.term, k.id]));

  // Insert ranking records
  const rankingRows = buildRankingRows(rankings, termToId);

  if (rankingRows.length > 0) {
    const { error: insertError } = await supabase
      .from("keyword_rankings")
      .insert(rankingRows);

    if (insertError) {
      throw new Error(`Failed to insert rankings: ${insertError.message}`);
    }
  }

  revalidatePath("/keywords");

  return { checked: rankingRows.length };
}

// ---------------------------------------------------------------------------
// fetchBacklinks
// ---------------------------------------------------------------------------

export async function fetchBacklinks(workspaceId: string) {
  const supabase = await createClient();
  const { data: workspace, error: wsError } = await supabase
    .from("workspaces")
    .select("id, domain")
    .eq("id", workspaceId)
    .single();
  if (wsError || !workspace) throw new Error("Workspace not found");
  if (!workspace.domain) throw new Error("Workspace has no domain configured");

  const result = await syncBacklinks(supabase, workspaceId, workspace.domain as string);
  revalidatePath("/backlinks");
  return result;
}

// ---------------------------------------------------------------------------
// scoreArticleSeo
// ---------------------------------------------------------------------------

export async function scoreArticleSeo(articleId: string) {
  const supabase = await createClient();

  // Fetch the article
  const { data: articleData, error: artError } = await supabase
    .from("articles")
    .select("*")
    .eq("id", articleId)
    .single();

  if (artError || !articleData) {
    throw new Error("Article not found");
  }

  const article = articleData as Article;

  // The site's domain, so the internal-link check can tell the site's own
  // pages from the ones it cites. Best effort: a missing domain scores the
  // way it always did, it does not stop the score.
  const { data: ws } = await supabase
    .from("workspaces")
    .select("domain")
    .eq("id", article.workspace_id)
    .single();

  // Convert Tiptap JSON content to HTML string for scoring.
  // If content is stored as Tiptap JSON, we serialise it simply;
  // if it's already a string, use it directly.
  let htmlContent: string;
  if (typeof article.content === "string") {
    htmlContent = article.content;
  } else if (article.content && typeof article.content === "object") {
    // Basic Tiptap JSON -> text extraction
    htmlContent = tiptapToHtml(article.content);
  } else {
    htmlContent = "";
  }

  if (!article.keyword) {
    throw new Error("Article has no target keyword set");
  }

  // Run the scoring
  const result = scoreArticle(htmlContent, article.keyword, {
    metaDescription: article.meta_description,
    siteDomain: ws?.domain ?? null,
    targetWordCount: article.research?.recommendedWordCount ?? null,
    title: article.title,
  });

  // Insert the audit record
  const { error: auditError } = await supabase.from("seo_audits").insert({
    article_id: articleId,
    score: result.score,
    checks: result.checks,
  });

  if (auditError) {
    throw new Error(`Failed to insert SEO audit: ${auditError.message}`);
  }

  // Update the article's seo_score
  const { error: updateError } = await supabase
    .from("articles")
    // Persist the per-check breakdown, not just the aggregate. scoreArticle
    // already returns checks[] with a name, a pass/fail and a note for each of
    // the 11 checks; storing only result.score threw that away and left the
    // reviewer with an unexplained number.
    .update({
      seo_score: result.score,
      seo_checks: result.checks,
      updated_at: new Date().toISOString(),
    })
    .eq("id", articleId);

  if (updateError) {
    throw new Error(`Failed to update article score: ${updateError.message}`);
  }

  revalidatePath("/articles");
  revalidatePath(`/content/${articleId}`);

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal Tiptap JSON to HTML converter.
 * Handles the common node types; enough for SEO scoring purposes.
 */
function tiptapToHtml(doc: Record<string, unknown>): string {
  if (!doc || !Array.isArray((doc as { content?: unknown[] }).content)) return "";

  const nodes = (doc as { content: TiptapNode[] }).content;
  return nodes.map(nodeToHtml).join("");
}

type TiptapNode = {
  type: string;
  content?: TiptapNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};

function nodeToHtml(node: TiptapNode): string {
  if (node.type === "text") {
    let text = node.text ?? "";
    if (node.marks) {
      for (const mark of node.marks) {
        if (mark.type === "bold") text = `<strong>${text}</strong>`;
        if (mark.type === "italic") text = `<em>${text}</em>`;
        if (mark.type === "link") {
          const href = (mark.attrs?.href as string) ?? "#";
          text = `<a href="${href}">${text}</a>`;
        }
      }
    }
    return text;
  }

  const children = (node.content ?? []).map(nodeToHtml).join("");

  switch (node.type) {
    case "heading": {
      const level = (node.attrs?.level as number) ?? 2;
      return `<h${level}>${children}</h${level}>`;
    }
    case "paragraph":
      return `<p>${children}</p>`;
    case "bulletList":
      return `<ul>${children}</ul>`;
    case "orderedList":
      return `<ol>${children}</ol>`;
    case "listItem":
      return `<li>${children}</li>`;
    case "blockquote":
      return `<blockquote>${children}</blockquote>`;
    case "codeBlock":
      return `<pre><code>${children}</code></pre>`;
    case "horizontalRule":
      return "<hr />";
    case "hardBreak":
      return "<br />";
    default:
      return children;
  }
}
