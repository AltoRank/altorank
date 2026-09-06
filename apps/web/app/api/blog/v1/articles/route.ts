import { ARTICLE_LIST_COLUMNS, authenticateBlogRequest, json } from "@/lib/blog-api/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/blog/v1/articles?workspace_id=<uuid>&page=1&per_page=20
 *
 * Live articles only: `status = 'live'` is the one state past the approval
 * gate and the publish, so a draft, a review copy or an approved-but-unpublished
 * article never appears on a customer's site through this route.
 */
export async function GET(request: Request) {
  const auth = await authenticateBlogRequest(request);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  const perPage = Math.min(100, Math.max(1, Number(params.get("per_page") ?? "20") || 20));
  const from = (page - 1) * perPage;

  const { data, error, count } = await auth.supabase
    .from("articles")
    .select(ARTICLE_LIST_COLUMNS, { count: "exact" })
    .eq("workspace_id", auth.workspaceId)
    .eq("status", "live")
    .order("published_at", { ascending: false, nullsFirst: false })
    .range(from, from + perPage - 1);

  if (error) return json({ error: error.message }, { status: 500 });

  return json({
    articles: data ?? [],
    page,
    per_page: perPage,
    total: count ?? 0,
  });
}
