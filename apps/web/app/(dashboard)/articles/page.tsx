import type { Metadata } from "next";
import Link from "next/link";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getArticles } from "@/lib/queries/articles";
import { createClient } from "@/lib/supabase/server";
import { PageHead, DotSep, StatusPill, Card, StatStrip } from "@/components/ui";
import { ArticleActions } from "@/components/dashboard/article-actions";
import { ArticleFilters } from "@/components/dashboard/article-filters";
import { ArticleRowMenu } from "@/components/dashboard/article-row-menu";
import type { Workspace } from "@/lib/types";
import { plural } from "@/lib/utils";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";

export const metadata: Metadata = { title: "Articles" };

/** How many drafts are waiting on a person, whatever the page is filtered to. */
async function countArticlesInReview(workspaceId: string | null): Promise<number> {
  const supabase = await createClient();
  let q = supabase.from("articles").select("id", { count: "exact", head: true }).eq("status", "review");
  if (workspaceId) q = q.eq("workspace_id", workspaceId);
  const { count } = await q;
  return count ?? 0;
}

type Props = {
  searchParams: Promise<{ status?: string; sort?: string; q?: string }>;
};

/** ISO date `n` days back. Outside the component so the clock read is not part of render. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

export default async function ArticlesPage({ searchParams }: Props) {
  // Every section is about one site unless the switcher says otherwise.
  const scopeId = await getScopedWorkspaceId();
  const params = await searchParams;
  const statusFilter = params.status ?? "";

  /**
   * The third read is what each live article actually earned: Search Console
   * clicks over the last 30 days, attributed per article by the analytics
   * cron. Dash when nothing is attributed - either GSC is not connected or the
   * article is not published - because "0 clicks" and "nobody measured" are
   * different facts.
   *
   * It joins the other two rather than following them: it is keyed by date
   * alone and never needed the article list it used to wait for.
   */
  const supabase = await createClient();
  const since = daysAgo(30);

  const [workspaces, allArticles, { data: metricRows }] = await Promise.all([
    getWorkspaces(),
    getArticles(scopeId ?? undefined, params.status, params.sort),
    supabase
      .from("analytics_metrics")
      .select("article_id, clicks")
      .not("article_id", "is", null)
      .gte("metric_date", since),
  ]);
  const clicksByArticle = new Map<string, number>();
  for (const m of metricRows ?? []) {
    if (!m.article_id) continue;
    clicksByArticle.set(
      m.article_id,
      (clicksByArticle.get(m.article_id) ?? 0) + (m.clicks ?? 0),
    );
  }

  // Which workspaces can publish from this list: the ones with a CMS
  // connected. The row menu offers "Publish now" for those; the rest are
  // sent to the editor, where the copy-and-record path lives.
  const { data: cmsRows } = workspaces.length
    ? await supabase
        .from("workspace_integrations")
        .select("workspace_id, integration:integrations(tag)")
        .in("workspace_id", workspaces.map((w) => w.id))
    : { data: [] as Array<{ workspace_id: string; integration: unknown }> };
  const cmsWorkspaces = new Set(
    (cmsRows ?? [])
      .filter((r) => (r.integration as { tag?: string } | null)?.tag === "CMS")
      .map((r) => r.workspace_id as string),
  );

  if (workspaces.length === 0) {
    return <div className="p-8 text-ink-3">No workspaces yet. Add one to start.</div>;
  }

  const wsMap = new Map<string, Workspace>(workspaces.map((w) => [w.id, w]));
  const rows = allArticles;

  const liveCount = rows.filter((a) => a.status === "live").length;
  // Counted independently of the active filter. Derived from `rows` it read
  // as zero whenever someone was filtered onto Live, hiding the one thing
  // that was waiting on them (2026-09-02).
  const reviewCount = statusFilter
    ? (await countArticlesInReview(scopeId))
    : rows.filter((a) => a.status === "review").length;
  const scored = rows.filter((a) => a.seo_score > 0);
  const avgScore = scored.length > 0
    ? Math.round(scored.reduce((s, a) => s + a.seo_score, 0) / scored.length)
    : 0;

  return (
    <>
      {/* This page wore one workspace's name - workspaces[0], whichever was
          created first - above a tab bar in which five of six tabs were
          permanently disabled buttons duplicating the sidebar. The nav item
          says Articles; the page now shows the articles, all of them, with
          the workspace as a column. Per-workspace drill-down lives where it
          says it does: /workspaces/[id]. */}
      <PageHead
        title="Articles"
        subtitle={
          <>
            <span>{plural(rows.length, "article")}</span>
            {wsMap.get(scopeId ?? "")?.domain ? (
              <>
                <DotSep />
                <span className="font-mono text-[11.5px]">{wsMap.get(scopeId ?? "")?.domain}</span>
              </>
            ) : null}
          </>
        }
        actions={<ArticleActions workspaces={workspaces} articles={allArticles} scopedId={scopeId} />}
      />

      <StatStrip
        stats={[
          // Review leads the strip: it is the only number that is a request
          // for someone to do something (2026-09-02).
          { label: "Needs review", value: reviewCount, delta: reviewCount > 0 ? "waiting on you" : "nothing pending", deltaType: reviewCount > 0 ? "neg" : undefined },
          { label: "Live", value: liveCount, delta: `${liveCount} published`, deltaType: "pos" },
          { label: "Avg SEO score", value: avgScore || "—", delta: avgScore > 0 ? "from audits" : "no data" },
          { label: "Total", value: rows.length },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        {/* The review queue used to be its own nav item, which meant the
            work waiting on a person lived one click away from the page they
            were already on. It is a banner here instead (2026-09-02). */}
        {reviewCount > 0 && statusFilter !== "review" && (
          <Link
            href="/articles?status=review"
            className="mb-4 flex items-center justify-between rounded-[9px] border border-line bg-panel px-4 py-3 text-[13px] hover:border-ink-4"
          >
            <span>
              <strong className="font-medium">{plural(reviewCount, "article")}</strong>{" "}
              <span className="text-ink-3">drafted and waiting for your yes before publishing.</span>
            </span>
            <span className="text-accent-ink underline decoration-line underline-offset-[3px]">Review them</span>
          </Link>
        )}
        <ArticleFilters />

        <Card flush>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {["Article", ...(scopeId ? [] : ["Workspace"]), "Keyword", "Status", "Score", "Vol /mo", "Position", "Clicks /30d", "CMS", "Updated", ""].map((h, i) => (
                  <th key={h || i} className={`font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel ${["Score", "Vol /mo", "Position", "Clicks /30d", "Updated"].includes(h) ? "text-right" : "text-left"}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const dateStr = a.updated_at ? new Date(a.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
                return (
                  <tr key={a.id} className="hover:[&>td]:bg-panel">
                    <td className="px-3.5 py-3 border-b border-line-soft" style={{ maxWidth: 0 }}>
                      <Link
                        href={`/content/${a.id}`}
                        className="block truncate font-medium hover:text-accent-ink hover:underline decoration-line underline-offset-[3px]"
                      >
                        {a.title}
                      </Link>
                      <div className="text-[11px] text-ink-3 mt-0.5">{a.word_count ? `${a.word_count.toLocaleString()} words` : "Draft in progress"}</div>
                    </td>
                    {!scopeId && (
<td className="px-3.5 py-3 border-b border-line-soft text-xs text-ink-2">{wsMap.get(a.workspace_id)?.name ?? "—"}</td>
                    )}
                    <td className="px-3.5 py-3 border-b border-line-soft font-mono text-xs text-ink-2">{a.keyword}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft"><StatusPill status={a.status} /></td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{a.seo_score || "—"}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{typeof a.volume === "number" ? a.volume.toLocaleString() : "—"}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{a.position ? `#${a.position}` : "—"}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{clicksByArticle.has(a.id) ? clicksByArticle.get(a.id)!.toLocaleString() : "—"}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft font-mono text-xs text-ink-2">{a.cms ?? "—"}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{dateStr}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <ArticleRowMenu
                        articleId={a.id}
                        currentStatus={a.status}
                        canPublish={cmsWorkspaces.has(a.workspace_id)}
                      />
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-3.5 py-8 text-center text-ink-3">No articles yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}
