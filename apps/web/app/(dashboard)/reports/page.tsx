import type { Metadata } from "next";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getReports } from "@/lib/queries/reports";
import { PageHead, StatusPill, Avatar, Icons, Card, ConnectPrompt } from "@/components/ui";
import { GenerateReportButton } from "@/components/dashboard/generate-report-button";
import { OpenReportButton } from "@/components/dashboard/open-report-button";
import type { Workspace } from "@/lib/types";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";

export const metadata: Metadata = { title: "Reports" };

/**
 * Reachable by URL but not linked: the section is listed as "soon" in the
 * sidebar because it is not ready to be relied on (2026-09-02).
 */
export default async function ReportsPage() {
  // Every section is about one site unless the switcher says otherwise.
  const scopeId = await getScopedWorkspaceId();
  const [workspaces, reports] = await Promise.all([
    getWorkspaces(),
    getReports(scopeId ?? undefined),
  ]);

  const wsMap = new Map<string, Workspace>(workspaces.map((w) => [w.id, w]));

  return (
    <>
      <PageHead
        title="Reports"
        subtitle={<span>Monthly PDF reports, branded with your logo and colour</span>}
        actions={workspaces.length > 0 ? <GenerateReportButton workspaces={workspaces} /> : undefined}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <Card flush>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {[...(scopeId ? [] : ["Workspace"]), "Period", "Articles", "Traffic", "Keywords", "Status", ""].map((h) => (
                  <th key={h} className={`font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel ${["Articles", "Traffic", "Keywords"].includes(h) ? "text-right" : "text-left"}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => {
                const w = wsMap.get(r.workspace_id);
                return (
                  <tr key={r.id} className="hover:[&>td]:bg-panel">
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      {w && (
                        <span className="inline-flex items-center gap-2.5">
                          <Avatar initials={w.initials} color={w.color} />
                          <b>{w.name}</b>
                        </span>
                      )}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft font-mono text-xs text-ink-2">{r.period}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{r.articles_count}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{r.traffic ?? "—"}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{r.keywords_count}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft"><StatusPill status={r.status === "delivered" ? "on" : r.status} label={r.status === "delivered" ? "Delivered" : r.status} /></td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      {r.url ? (
                        <OpenReportButton reportId={r.id} />
                      ) : (
                        <span className="text-ink-3 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {reports.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-0 py-0">
                      <ConnectPrompt
                        icon="reports"
                        service="Google Search Console"
                        title="No reports generated yet"
                        body="A monthly report summarises traffic, rankings and what shipped. It needs an analytics connection first, or every figure in it would be blank."
                        href="/connect"
                        cta="Connect analytics"
                      />
                    </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}
