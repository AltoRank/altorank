import type { Metadata } from "next";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getArticles } from "@/lib/queries/articles";
import { createClient } from "@/lib/supabase/server";
import { PageHead, DotSep, StatusPill, Card, StatStrip } from "@/components/ui";
import { ArticleActions } from "@/components/dashboard/article-actions";
import { ArticleFilters } from "@/components/dashboard/article-filters";
import { ArticleRowMenu } from "@/components/dashboard/article-row-menu";
import type { Workspace } from "@/lib/types";
import { plural } from "@/lib/utils";

export const metadata: Metadata = { title: "Articles" };

type Props = {
  searchParams: Promise<{ status?: string; sort?: string; q?: string }>;
};

export default async function ArticlesPage({ searchParams }: Props) {
  const params = await searchParams;

  const [workspaces, allArticles] = await Promise.all([
    getWorkspaces(),
    getArticles(undefined, params.status, params.sort),
  ]);

  /**
   * What each live article actually earned: Search Console clicks over the
   * last 30 days, attributed per article by the analytics cron. Dash when
   * nothing is attributed - either GSC is not connected or the article is
   * not published - because "0 clicks" and "nobody measured" are different
   * facts.
   */
  const supabase = await createClient();
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const { data: metricRows } = await supabase
    .from("analytics_metrics")
    .select("article_id, clicks")
    .not("article_id", "is", null)
    .gte("metric_date", since);
  const clicksByArticle = new Map<string, number>();
  for (const m of metricRows ?? []) {
    if (!m.article_id) continue;
    clicksByArticle.set(
      m.article_id,
      (clicksByArticle.get(m.article_id) ?? 0) + (m.clicks ?? 0),
    );
  }

  if (workspaces.length === 0) {
    return <div className="p-8 text-ink-3">No workspaces yet. Add one to start.</div>;
  }

  const wsMap = new Map<string, Workspace>(workspaces.map((w) => [w.id, w]));
  const rows = allArticles;

  const liveCount = rows.filter((a) => a.status === "live").length;
  const reviewCount = rows.filter((a) => a.status === "review").length;
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
            <DotSep />
            <span>across {plural(workspaces.length, "workspace")}</span>
          </>
        }
        actions={<ArticleActions workspaces={workspaces} articles={allArticles} />}
      />

      <StatStrip
        stats={[
          { label: "Live", value: liveCount, delta: `${liveCount} published`, deltaType: "pos" },
          { label: "In review", value: reviewCount, delta: reviewCount > 0 ? "waiting on editor" : "none pending" },
          { label: "Avg SEO score", value: avgScore || "—", delta: avgScore > 0 ? "from audits" : "no data" },
          { label: "Total", value: rows.length },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <ArticleFilters />

        <Card flush>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {["Article", "Workspace", "Keyword", "Status", "Score", "Vol /mo", "Position", "Clicks /30d", "CMS", "Updated", ""].map((h, i) => (
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
                  <tr key={a.id} className="cursor-pointer hover:[&>td]:bg-panel">
                    <td className="px-3.5 py-3 border-b border-line-soft" style={{ maxWidth: 0 }}>
                      <div className="truncate font-medium">{a.title}</div>
                      <div className="text-[11px] text-ink-3 mt-0.5">{a.word_count ? `${a.word_count.toLocaleString()} words` : "Draft in progress"}</div>
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-xs text-ink-2">{wsMap.get(a.workspace_id)?.name ?? "—"}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft font-mono text-xs text-ink-2">{a.keyword}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft"><StatusPill status={a.status} /></td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{a.seo_score || "—"}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{typeof a.volume === "number" ? a.volume.toLocaleString() : "—"}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{a.position ? `#${a.position}` : "—"}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{clicksByArticle.has(a.id) ? clicksByArticle.get(a.id)!.toLocaleString() : "—"}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft font-mono text-xs text-ink-2">{a.cms ?? "—"}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{dateStr}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <ArticleRowMenu articleId={a.id} currentStatus={a.status} />
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
