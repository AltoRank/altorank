import { withAgent, appBaseUrl } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { articleInAgency, workspaceInAgency } from "@/lib/agent/data";
import { tiptapToHtml } from "@/lib/cms/html";
import { renderArticleMarkdown } from "@/lib/publishing/export";

type Format = "markdown" | "html" | "tiptap";

/**
 * GET /api/agent/v1/articles/{id}/content?format=markdown|html|tiptap
 *
 * The body, rendered by the same functions the export buttons use. Markdown
 * by default, since that is what a model reads best.
 */
export const GET = withAgent<{ id: string }>(async (request, ctx, { id }) => {
  const article = await articleInAgency(ctx, id);
  if (!article) {
    return fail("not_found", "Article not found in this account.", "Call GET /articles?workspace_id= and use an id from that list.");
  }
  if (!article.content) {
    return fail(
      "not_available",
      "This article has no content yet.",
      article.status === "drafting"
        ? "It is still being written. Poll GET /articles/{id} until status is review."
        : "Nothing was generated for it. You may regenerate if allowed_mutations permits.",
    );
  }

  const requested = (request.nextUrl.searchParams.get("format") ?? "markdown") as Format;
  if (!["markdown", "html", "tiptap"].includes(requested)) {
    return fail("invalid_request", `Unknown format "${requested}".`, "Use format=markdown, html or tiptap.");
  }

  const editorUrl = `${appBaseUrl(request)}/content/${article.id}`;
  const base = { article_id: article.id, title: article.title, status: article.status, editor_url: editorUrl };
  const guidance =
    "Read it; do not edit it here. Suggested changes go to the human, who edits at editor_url. Quote the text, never invent metrics about it.";

  if (requested === "tiptap") return ok({ ...base, format: "tiptap", content: article.content }, guidance);

  const html = tiptapToHtml(article.content);
  if (requested === "html") return ok({ ...base, format: "html", content: html }, guidance);

  const workspace = await workspaceInAgency(ctx, article.workspace_id);
  const siteUrl = workspace?.domain ? `https://${workspace.domain}` : appBaseUrl(request);
  const markdown = renderArticleMarkdown(
    {
      title: article.title,
      slug: article.slug,
      html,
      metaDescription: article.meta_description,
      keyword: article.keyword,
      featuredImageUrl: article.featured_image_url,
      publishedAt: article.published_at,
    },
    siteUrl,
  );
  return ok({ ...base, format: "markdown", content: markdown }, guidance);
});
