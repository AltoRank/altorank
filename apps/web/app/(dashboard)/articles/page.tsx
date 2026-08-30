import type { Metadata } from "next";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getArticles } from "@/lib/queries/articles";
import { PageHead, DotSep, StatusPill, Avatar, Icons, Card, StatStrip } from "@/components/ui";
import { IconButton } from "@/components/ui/button";
import { ArticleActions } from "@/components/dashboard/article-actions";
import { ArticleFilters } from "@/components/dashboard/article-filters";
import { ArticleRowMenu } from "@/components/dashboard/article-row-menu";
import type { Workspace } from "@/lib/types";

export const metadata: Metadata = { title: "Articles" };

type Props = {
  searchParams: Promise<{ status?: string; sort?: string }>;
};

export default async function ArticlesPage({ searchParams }: Props) {
  const params = await searchParams;

  const [workspaces, allArticles] = await Promise.all([
    getWorkspaces(),
    getArticles(undefined, params.status, params.sort),
  ]);

  const ws = workspaces[0];
  if (!ws) {
    return <div className="p-8 text-ink-3">No workspaces found. Create a client first.</div>;
  }

  const wsMap = new Map<string, Workspace>(workspaces.map((w) => [w.id, w]));
  const wsArticles = allArticles.filter((a) => a.workspace_id === ws.id);
  const otherArticles = allArticles.filter((a) => a.workspace_id !== ws.id).slice(0, 6);
  const rows = [...wsArticles, ...otherArticles];

  const liveCount = wsArticles.filter((a) => a.status === "live").length;
  const reviewCount = wsArticles.filter((a) => a.status === "review").length;
  const avgScore = wsArticles.length > 0
    ? Math.round(wsArticles.reduce((s, a) => s + a.seo_score, 0) / wsArticles.length)
    : 0;

  return (
    <>
      <PageHead
        title={
          <span className="flex items-center gap-3">
            <Avatar initials={ws.initials} color={ws.color} size="lg" className="w-[30px] h-[30px] text-xs" />
            {ws.name}
          </span> as unknown as string
        }
        eyebrow={
          <>
            <span className="font-mono px-[7px] py-0.5 bg-panel-2 rounded text-ink-2">{ws.domain}</span>
            <StatusPill status={ws.status} />
          </>
        }
        subtitle={
          <>
            <span>{wsArticles.length} articles</span>
            <DotSep />
            <span>{ws.traffic} organic /mo</span>
            <DotSep />
            <span>DR {ws.dr}</span>
            <DotSep />
            <span>{ws.plan ?? "—"} plan</span>
          </>
        }
        actions={<ArticleActions workspace={ws} articles={allArticles} />}
      />

      <StatStrip
        stats={[
          { label: "Live", value: liveCount, delta: `${liveCount} published`, deltaType: "pos" },
          { label: "In review", value: reviewCount, delta: reviewCount > 0 ? "waiting on editor" : "none pending" },
          { label: "Avg SEO score", value: avgScore || "—", delta: avgScore > 0 ? "from audits" : "no data" },
          { label: "Total", value: wsArticles.length },
        ]}
      />

      <div className="px-8 flex gap-0 items-center border-b border-line bg-bg">
        {[
          { label: "Articles", icon: <Icons.articles size={14} />, count: wsArticles.length, active: true },
          { label: "Keywords", icon: <Icons.keywords size={14} /> },
          { label: "Calendar", icon: <Icons.calendar size={14} /> },
          { label: "Backlinks", icon: <Icons.backlinks size={14} /> },
          { label: "Voice", icon: <Icons.voice size={14} /> },
          { label: "Settings", icon: <Icons.settings size={14} /> },
        ].map((tab) => (
          <button
            key={tab.label}
            disabled={!tab.active}
            className={`px-3.5 py-3 text-[13.5px] border-b-2 -mb-px flex items-center gap-[7px] cursor-pointer transition-colors disabled:opacity-40 disabled:pointer-events-none ${
              tab.active ? "text-ink border-b-ink font-medium" : "text-ink-3 border-transparent hover:text-ink"
            }`}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.count != null && (
              <span className="px-1.5 font-mono text-[10.5px] font-medium bg-panel-2 text-ink-2 rounded-full">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <ArticleFilters />

        <Card>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {["Article", "Keyword", "Status", "Score", "Vol /mo", "Position", "CMS", "Updated", ""].map((h, i) => (
                  <th key={h || i} className={`font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel ${["Score", "Vol /mo", "Position", "Updated"].includes(h) ? "text-right" : "text-left"}`}>
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
                    <td className="px-3.5 py-3 border-b border-line-soft font-mono text-xs text-ink-2">{a.keyword}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft"><StatusPill status={a.status} /></td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{a.seo_score || "—"}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{a.volume.toLocaleString()}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{a.position ? `#${a.position}` : "—"}</td>
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
                  <td colSpan={9} className="px-3.5 py-8 text-center text-ink-3">No articles yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}
