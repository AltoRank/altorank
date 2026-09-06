import type { Metadata } from "next";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getReports } from "@/lib/queries/reports";
import { PageHead, StatusPill, Avatar, Card, ConnectPrompt, DataTable } from "@/components/ui";
import { GenerateReportButton } from "@/components/dashboard/generate-report-button";
import { OpenReportButton } from "@/components/dashboard/open-report-button";
import type { Workspace } from "@/lib/types";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";

export const metadata: Metadata = { title: "Reports" };

/**
 * Linked from the sidebar since 2026-09-06. It was listed as "soon", which
 * renders as unclickable grey text, while the page itself listed reports and
 * generated them.
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
        /* Not "your logo and colour": nothing writes agencies.logo_url, so the
           report only ever carries the accent colour and the workspace
           initials. Logo upload is still unbuilt (2026-09-06). */
        subtitle={<span>Monthly PDF reports, in your accent colour</span>}
        actions={workspaces.length > 0 ? <GenerateReportButton workspaces={workspaces} /> : undefined}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        {/* DataTable, not a hand-written <table>. The old one dropped the
            "Workspace" header when the page was scoped but still rendered the
            workspace cell in every row, so on the view a signed-in user
            actually gets, every column sat one place left of its heading -
            Period under Workspace, Articles under Period. The empty row's
            colSpan was 5 against six or seven columns for the same reason. */}
        <Card flush>
          {reports.length === 0 ? (
            <ConnectPrompt
              icon="reports"
              service="Google Search Console"
              title="No reports generated yet"
              body="A monthly report summarises traffic, rankings and what shipped. It needs an analytics connection first, or every figure in it would be blank."
              href="/connect"
              cta="Connect analytics"
            />
          ) : (
            <DataTable
              data={reports}
              columns={[
                // The scope gives this page one site and the switcher names
                // it, so a Workspace column repeated that one name down
                // every row. Kept for a merged view, which is the only case
                // it distinguishes anything.
                ...(scopeId
                  ? []
                  : [
                      {
                        key: "workspace",
                        header: "Workspace",
                        render: (r: (typeof reports)[number]) => {
                          const w = wsMap.get(r.workspace_id);
                          return w ? (
                            <span className="inline-flex items-center gap-2.5">
                              <Avatar initials={w.initials} color={w.color} />
                              <b>{w.name}</b>
                            </span>
                          ) : null;
                        },
                      },
                    ]),
                { key: "period", header: "Period", render: (r) => <span className="font-mono text-xs text-ink-2">{r.period}</span> },
                { key: "articles", header: "Articles", numeric: true, render: (r) => r.articles_count },
                { key: "traffic", header: "Traffic", numeric: true, render: (r) => r.traffic ?? "—" },
                { key: "keywords", header: "Keywords", numeric: true, render: (r) => r.keywords_count },
                {
                  key: "status",
                  header: "Status",
                  // Every other table capitalises its pill. This one passed
                  // the raw column through, so a report read "ready".
                  render: (r) => (
                    <StatusPill
                      status={r.status === "delivered" ? "on" : r.status}
                      label={r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                    />
                  ),
                },
                {
                  key: "open",
                  header: "",
                  render: (r) => (r.url ? <OpenReportButton reportId={r.id} /> : <span className="text-ink-3 text-xs">—</span>),
                },
              ]}
            />
          )}
        </Card>
      </div>
    </>
  );
}
