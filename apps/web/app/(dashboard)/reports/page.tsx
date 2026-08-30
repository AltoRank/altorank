import type { Metadata } from "next";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getReports } from "@/lib/queries/reports";
import { PageHead, StatusPill, Avatar, Icons, Card } from "@/components/ui";
import { GenerateReportButton } from "@/components/dashboard/generate-report-button";
import { OpenReportButton } from "@/components/dashboard/open-report-button";
import type { Workspace } from "@/lib/types";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage() {
  const [workspaces, reports] = await Promise.all([
    getWorkspaces(),
    getReports(),
  ]);

  const wsMap = new Map<string, Workspace>(workspaces.map((w) => [w.id, w]));
  const firstWs = workspaces[0];

  return (
    <>
      <PageHead
        title="Reports"
        eyebrow={<span>Client reports</span>}
        subtitle={<span>White-labelled monthly reports for every client</span>}
        actions={firstWs ? <GenerateReportButton workspaceId={firstWs.id} /> : undefined}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <Card>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {["Client", "Period", "Articles", "Traffic", "Keywords", "Status", ""].map((h) => (
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
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{r.traffic}</td>
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
                  <td colSpan={7} className="px-3.5 py-8 text-center text-ink-3">No reports generated yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}
