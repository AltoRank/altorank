import type { Metadata } from "next";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getWorkspaceAudits } from "@/app/actions/audit";
import { PageHead, Avatar, Icons, Button, Card, StatStrip } from "@/components/ui";
import type { Workspace } from "@/lib/types";
import { StartAuditButton } from "@/components/dashboard/start-audit-button";
import { AuditRow } from "@/components/dashboard/audit-row";
import { plural } from "@/lib/utils";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";

export const metadata: Metadata = { title: "Audits" };

export default async function AuditsPage() {
  // One site at a time. Audits from two domains side by side read as one
  // number and mean nothing (2026-09-02).
  const scopeId = await getScopedWorkspaceId();
  const all = await getWorkspaces();
  const workspaces = scopeId ? all.filter((w) => w.id === scopeId) : all;

  // Fetch audits for the workspace in scope
  const auditsByWs = await Promise.all(
    workspaces.map(async (ws) => ({
      workspace: ws,
      audits: await getWorkspaceAudits(ws.id),
    })),
  );

  const allAudits = auditsByWs.flatMap((x) => x.audits);
  const completedAudits = allAudits.filter((a) => a.status === "completed");
  const avgScore =
    completedAudits.length > 0
      ? Math.round(
          completedAudits.reduce((s, a) => s + (a.overall_score ?? 0), 0) /
            // Average only over audits that actually produced a score.
            Math.max(1, completedAudits.filter((a) => typeof a.overall_score === "number").length),
        )
      : 0;
  const totalIssues = completedAudits.reduce((s, a) => s + a.issues.length, 0);
  const totalPages = completedAudits.reduce((s, a) => s + a.pages_crawled, 0);
  const wsMap = new Map<string, Workspace>(workspaces.map((w) => [w.id, w]));

  return (
    <>
      <PageHead
        title="Site Audits"
        subtitle={
          <span>
            {plural(allAudits.length, "audit")}
            {workspaces[0]?.domain ? <> for <span className="font-mono text-ink-2">{workspaces[0].domain}</span></> : null}
          </span>
        }
      />

      <StatStrip
        stats={[
          { label: "Total audits", value: String(allAudits.length) },
          {
            label: "Avg score",
            value: avgScore > 0 ? String(avgScore) : "—",
            delta:
              avgScore > 0
                ? avgScore >= 80
                  ? "healthy"
                  : avgScore >= 50
                    ? "needs work"
                    : "critical"
                : "no audits yet",
            deltaType: avgScore > 0 ? (avgScore >= 80 ? "pos" : "neg") : undefined,
          },
          { label: "Issues found", value: String(totalIssues) },
          { label: "Pages crawled", value: String(totalPages) },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        {workspaces.map((ws) => {
          const wsAudits = auditsByWs.find((x) => x.workspace.id === ws.id)?.audits ?? [];
          return (
            <div key={ws.id} className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <span className="inline-flex items-center gap-2.5 text-sm font-medium">
                  <Avatar initials={ws.initials} color={ws.color} />
                  {ws.name}
                  <span className="text-ink-3 font-normal">{ws.domain}</span>
                </span>
                <StartAuditButton workspaceId={ws.id} />
              </div>

              <Card flush>
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      {["Date", "Score", "Pages", "Issues", "Status"].map((h) => (
                        <th
                          key={h}
                          className={`font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel ${
                            ["Score", "Pages", "Issues"].includes(h) ? "text-right" : "text-left"
                          }`}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {wsAudits.map((a) => (
                      <AuditRow key={a.id} audit={a} />
                    ))}
                    {wsAudits.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-3.5 py-8 text-center text-ink-3">
                          No audits yet — run your first audit above
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Card>
            </div>
          );
        })}
      </div>
    </>
  );
}
