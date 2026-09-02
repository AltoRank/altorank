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
import { getScopedWorkspaceId } from "@/lib/workspace-scope";

export const metadata: Metadata = { title: "Backlinks" };

type Props = {
  searchParams: Promise<{ status?: string; workspace?: string }>;
};

export default async function BacklinksPage({ searchParams }: Props) {
  // Every section is about one site unless the switcher says otherwise.
  const scopeId = await getScopedWorkspaceId();
  const params = await searchParams;

  const [workspaces, backlinks] = await Promise.all([
    getWorkspaces(),
    getBacklinks(params.workspace ?? scopeId ?? undefined, params.status),
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
            <DiscoverBacklinksButton workspaces={workspaces} scopedId={scopeId} />
            {workspaces.length > 0 && <ExchangeRequestForm workspaces={workspaces} />}
          </>
        }
      />

      <StatStrip
        stats={[
          { label: "Total backlinks", value: String(backlinks.length), delta: `${liveCount} live`, deltaType: "pos" },
          { label: "Avg DR", value: avgDr, delta: "source authority" },
          { label: "Followed", value: String(backlinks.filter((b) => b.is_dofollow).length), delta: "pass authority" },
          { label: "Pending", value: String(pendingCount), delta: "awaiting publisher" },
          { label: "Lost", value: String(backlinks.filter((b) => b.status === "lost").length) },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <BacklinkFilters />

        <Card flush>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {["From", "DR", "Anchor", "To", "Link", "First seen", ...(scopeId ? [] : ["Workspace"]), "Status"].map((h) => (
                  <th key={h} className={`font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel ${["DR", "First seen"].includes(h) ? "text-right" : "text-left"}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {backlinks.map((b) => {
                const w = wsMap.get(b.workspace_id);
                return (
                  <tr key={b.id} className="hover:[&>td]:bg-panel">
                    <td className="px-3.5 py-3 border-b border-line-soft font-mono text-ink font-medium">
                      {b.source_url ? (
                        <a href={b.source_url} target="_blank" rel="noopener noreferrer nofollow" className="hover:underline" title={b.source_url}>
                          {b.source_domain}
                        </a>
                      ) : (
                        b.source_domain
                      )}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{b.source_dr}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-accent-ink">
                      {b.source_url ? (
                        <a href={b.source_url} target="_blank" rel="noopener noreferrer nofollow" className="hover:underline">
                          &ldquo;{b.anchor_text || "no anchor text"}&rdquo;
                        </a>
                      ) : (
                        <>&ldquo;{b.anchor_text || "no anchor text"}&rdquo;</>
                      )}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft font-mono text-[11.5px]">
                      <a href={b.target_url} target="_blank" rel="noopener noreferrer" className="hover:underline">{b.target_url}</a>
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      {/* A nofollow link passes no authority. Counting it the
                          same as a followed one is the difference between a
                          backlink profile and a list of mentions. */}
                      {b.is_dofollow === false ? (
                        <span className="rounded-full bg-panel px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3">nofollow</span>
                      ) : b.is_dofollow ? (
                        <span className="rounded-full bg-ok-soft px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ok-ink">follow</span>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">
                      {b.first_seen ? new Date(b.first_seen).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "—"}
                    </td>
                    {!scopeId && (
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      {w && (
                        <span className="inline-flex items-center gap-2">
                          <Avatar initials={w.initials} color={w.color} size="sm" />
                          {w.name}
                        </span>
                      )}
                    </td>
                    )}
                    <td className="px-3.5 py-3 border-b border-line-soft"><StatusPill status={b.status} /></td>
                  </tr>
                );
              })}
              {backlinks.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3.5 py-8 text-center text-ink-3">No backlinks tracked yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}
