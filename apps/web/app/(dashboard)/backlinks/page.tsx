import type { Metadata } from "next";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getBacklinks } from "@/lib/queries/backlinks";
import { PageHead, DotSep, StatusPill, Avatar, Card, StatStrip } from "@/components/ui";
import { ExchangeRequestForm } from "@/components/dashboard/exchange-actions";
import { ExchangeMarketplace } from "@/components/dashboard/exchange-marketplace";
import { getOpenRequests } from "@/lib/queries/exchange";
import { requireAuth } from "@/lib/auth/require-auth";
import { BacklinkFreshness } from "@/components/dashboard/backlink-freshness";
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

  const { agencyId } = await requireAuth();
  const [workspaces, backlinks, openRequests] = await Promise.all([
    getWorkspaces(),
    getBacklinks(params.workspace ?? scopeId ?? undefined, params.status),
    // Other accounts' open requests. Reads with the service role behind a
    // fixed column list, because RLS scopes a member to rows their agency is
    // already part of, which an unclaimed request never is.
    getOpenRequests(agencyId),
  ]);

  const wsMap = new Map<string, Workspace>(workspaces.map((w) => [w.id, w]));
  // When this site's links were last looked up. The weekly pass inside the
  // rank cron does it; the button only exists for when someone cannot wait.
  const lastCheckedAt = backlinks.reduce<string | null>(
    (latest, b) => (b.discovered_at && (!latest || b.discovered_at > latest) ? b.discovered_at : latest),
    null,
  );
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
        subtitle={<><StatusPill status="on" label={plural(backlinks.length, "link")} /><span>{wsMap.get(scopeId ?? "")?.domain ?? plural(workspaces.length, "workspace")}</span><DotSep /><span>Avg DR {avgDr}</span></>}
        actions={
          <>
            <ExportCsv columns={csvColumns} rows={csvRows} filename="backlinks" />
            <BacklinkFreshness workspaces={workspaces} scopedId={scopeId} lastCheckedAt={lastCheckedAt} />
            {workspaces.length > 0 && <ExchangeRequestForm workspaces={workspaces} scopedId={scopeId} />}
          </>
        }
      />

      <StatStrip
        compact
        stats={[
          { label: "Total backlinks", value: String(backlinks.length), delta: `${liveCount} live`, deltaType: "pos", hint: "Links pointing at this site, one row per referring domain. From DataForSEO's backlink index, refreshed weekly." },
          { label: "Avg DR", value: avgDr, delta: "source authority", hint: "Average authority of the linking domains: DataForSEO's 0-1000 domain rank mapped to 0-100. Not Ahrefs DR." },
          { label: "Followed", value: String(backlinks.filter((b) => b.is_dofollow).length), delta: "pass authority", hint: "Links without rel=nofollow, ugc or sponsored. Only these pass authority; the rest are mentions." },
          { label: "Pending", value: String(pendingCount), delta: "awaiting publisher", hint: "Exchange requests accepted but not yet placed by the other site." },
          { label: "Lost", value: String(backlinks.filter((b) => b.status === "lost").length), delta: "gone since last check", hint: "Links present in an earlier check and missing from the latest one." },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        {/* The host side of the exchange. Hidden when nobody is asking, so an
            empty network shows nothing rather than an empty promise; the
            request form above is how a row gets here in the first place. */}
        {openRequests.length > 0 && (
          <Card
            title="Requests you could host"
            meta={`${openRequests.length} open`}
            className="mb-5"
            flush
          >
            <p className="px-[18px] py-3 text-[12.5px] leading-relaxed text-ink-2 border-b border-line-soft">
              Taking one gets you a full article for your own blog, on the next keyword your site
              should rank for, written at the requester&rsquo;s expense rather than out of your own
              monthly articles. It arrives in your review queue as a draft: edit it, cut the citation
              if it does not belong, publish it or reject it. Publishing costs you one credit and
              earns the writer one, which is why their citation can be a followed byline. Credits come
              from writing for other sites.
            </p>
            <ExchangeMarketplace requests={openRequests} workspaceId={scopeId} />
          </Card>
        )}

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
