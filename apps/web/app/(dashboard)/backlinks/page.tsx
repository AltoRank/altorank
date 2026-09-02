import type { Metadata } from "next";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getBacklinks } from "@/lib/queries/backlinks";
import { PageHead, DotSep, StatusPill, Avatar, Icons, Button, Card, StatStrip } from "@/components/ui";
import { ExchangeRequestForm } from "@/components/dashboard/exchange-actions";
import { DiscoverBacklinksButton } from "@/components/dashboard/discover-backlinks-button";
import { BacklinkFilters } from "@/components/dashboard/backlink-filters";
import { ExportCsv } from "@/components/dashboard/export-csv";
import type { Workspace } from "@/lib/types";
import { plural } from "@/lib/utils";

export const metadata: Metadata = { title: "Backlinks" };

type Props = {
  searchParams: Promise<{ status?: string }>;
};

export default async function BacklinksPage({ searchParams }: Props) {
  const params = await searchParams;

  const [workspaces, backlinks] = await Promise.all([
    getWorkspaces(),
    getBacklinks(undefined, params.status),
  ]);

  const wsMap = new Map<string, Workspace>(workspaces.map((w) => [w.id, w]));
  const liveCount = backlinks.filter((b) => b.status === "live").length;
  const pendingCount = backlinks.filter((b) => b.status === "pending").length;
  // Average over the links that actually carry a reading. Counting an
  // unmeasured link as DR 0 drags the reported authority of the whole set down,
  // and reporting 0 for "no links yet" states a measurement nobody took.
  const measuredDr = backlinks
    .map((b) => b.source_dr)
    .filter((d): d is number => typeof d === "number");
  const avgDr = measuredDr.length
    ? String(Math.round(measuredDr.reduce((s, d) => s + d, 0) / measuredDr.length))
    : "—";


  const csvColumns = ["Source", "DR", "Anchor", "Target", "Workspace", "Status", "Date"];
  const csvRows = backlinks.map((b) => {
    const w = wsMap.get(b.workspace_id);
    return [
      b.source_domain,
      String(b.source_dr),
      b.anchor_text,
      b.target_url,
      w?.name ?? "",
      b.status,
      b.discovered_at ? new Date(b.discovered_at).toISOString().split("T")[0] : "",
    ];
  });

  return (
    <>
      <PageHead
        title="Backlinks"
        subtitle={<><StatusPill status="on" label={plural(backlinks.length, "link")} /><span>Across {plural(workspaces.length, "workspace")}</span><DotSep /><span>Avg DR {avgDr}</span></>}
        actions={
          <>
            <ExportCsv columns={csvColumns} rows={csvRows} filename="backlinks" />
            <DiscoverBacklinksButton workspaces={workspaces} />
            {workspaces.length > 0 && <ExchangeRequestForm workspaces={workspaces} />}
          </>
        }
      />

      <StatStrip
        stats={[
          { label: "Total backlinks", value: String(backlinks.length), delta: `${liveCount} live`, deltaType: "pos" },
          { label: "Avg DR", value: avgDr, delta: "source authority" },
          { label: "Pending", value: String(pendingCount), delta: "awaiting publisher" },
          { label: "Lost", value: String(backlinks.filter((b) => b.status === "lost").length) },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <BacklinkFilters />

        <Card>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {["From", "DR", "Anchor", "To", "Workspace", "Status", "Date"].map((h) => (
                  <th key={h} className={`font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel ${["DR", "Date"].includes(h) ? "text-right" : "text-left"}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {backlinks.map((b) => {
                const w = wsMap.get(b.workspace_id);
                const dateStr = b.discovered_at ? new Date(b.discovered_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
                return (
                  <tr key={b.id} className="hover:[&>td]:bg-panel">
                    <td className="px-3.5 py-3 border-b border-line-soft font-mono text-ink font-medium">{b.source_domain}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{b.source_dr}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-accent-ink">&ldquo;{b.anchor_text}&rdquo;</td>
                    <td className="px-3.5 py-3 border-b border-line-soft font-mono text-[11.5px]">{b.target_url}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      {w && (
                        <span className="inline-flex items-center gap-2">
                          <Avatar initials={w.initials} color={w.color} size="sm" />
                          {w.name}
                        </span>
                      )}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft"><StatusPill status={b.status} /></td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{dateStr}</td>
                  </tr>
                );
              })}
              {backlinks.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3.5 py-8 text-center text-ink-3">No backlinks tracked yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}
