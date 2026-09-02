import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getRecentArticles, getArticles } from "@/lib/queries/articles";
import { getKeywords } from "@/lib/queries/keywords";
import { getTrafficSeries, type TrafficSeries } from "@/lib/queries/traffic";
import { PageHead, DotSep, StatusPill, Avatar, Icons, Button, Chip, Card, StatStrip, ConnectPrompt } from "@/components/ui";
import { ClientActions } from "@/components/dashboard/client-actions";
import { WorkspaceGrid } from "@/components/dashboard/workspace-grid";
import type { Workspace } from "@/lib/types";
import { plural } from "@/lib/utils";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * Organic clicks from Search Console.
 *
 * Both series used to be hardcoded arrays rising from 14 to 80, so every
 * account saw the same invented growth curve, directly under a stat that read
 * "Organic traffic — / Connect analytics". A chart is a claim; this one was
 * making a claim nobody had measured.
 *
 * Renders nothing when there is no data. A flat line at zero is also a claim,
 * and "we have not measured this" is a different statement from "you have no
 * traffic".
 */
function TrafficChart({ series, connected = false }: { series: TrafficSeries; connected?: boolean }) {
  if (!series.hasData) {
    // "Connect Search Console" under an account that has already connected it
    // is the wrong instruction: the next step is a property or a wait, not a
    // connection (2026-09-02).
    if (connected) {
      return (
        <div className="h-[220px] grid place-items-center px-8 text-center">
          <div className="max-w-[46ch] text-[13px] leading-relaxed text-ink-3">
            <div className="mb-1 text-[13.5px] font-medium text-ink-2">Search Console is connected, with nothing to plot yet</div>
            Search Console reports with about a two-day lag, and only pages that
            received clicks appear at all. If this stays empty, open Integrations:
            the sync reports there when the connected Google account cannot see a
            property for this domain.
          </div>
        </div>
      );
    }
    return (
      <div className="h-[220px] grid place-items-center">
        <ConnectPrompt
          icon="trend"
          service="Google Search Console"
          title="No traffic data yet"
          body="Connect Search Console and the daily sync fills this in. Nothing here is estimated, so the chart stays empty until there are real clicks to plot."
          href="/connect"
          cta="Connect Search Console"
        />
      </div>
    );
  }

  const data = series.current;
  const prev = series.previous;
  const W = 900, H = 160, pad = 24;
  // Guard the all-zero case: a max of 0 makes every y NaN and the path vanishes.
  const max = Math.max(...data, ...prev, 1) * 1.1;
  const x = (i: number) => pad + (i * (W - pad * 2)) / (data.length - 1);
  const y = (v: number) => H - pad - ((v / max) * (H - pad * 2));
  const path = (arr: number[]) => arr.map((v, i) => `${i ? "L" : "M"} ${x(i)} ${y(v)}`).join(" ");
  const area = path(data) + ` L ${x(data.length - 1)} ${H - pad} L ${x(0)} ${H - pad} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="220" preserveAspectRatio="none">
      <defs>
        <linearGradient id="g1" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.18" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <line key={f} x1={pad} x2={W - pad} y1={pad + f * (H - pad * 2)} y2={pad + f * (H - pad * 2)} stroke="var(--line-soft)" strokeWidth="1" />
      ))}
      <path d={area} fill="url(#g1)" />
      <path d={path(prev)} fill="none" stroke="var(--ink-4)" strokeWidth="1.5" strokeDasharray="4 4" />
      <path d={path(data)} fill="none" stroke="var(--accent)" strokeWidth="2" />
      {data.map((v, i) => i % 3 === 0 ? (
        <circle key={i} cx={x(i)} cy={y(v)} r="2.5" fill="var(--bg)" stroke="var(--accent)" strokeWidth="1.5" />
      ) : null)}
    </svg>
  );
}

export default async function DashboardPage() {
  const [workspaces, allArticles, recent, traffic, keywords] = await Promise.all([
    getWorkspaces(),
    getArticles(),
    getRecentArticles(6),
    getTrafficSeries(),
    getKeywords(),
  ]);
  // Whether any workspace has Google connected at all: it changes the empty
  // state from an instruction into an explanation.
  const gscSupabase = await createClient();
  const { count: gscCount } = await gscSupabase
    .from("workspace_integrations")
    .select("id", { count: "exact", head: true })
    .eq("integration_id", "gsc");
  const gscConnected = (gscCount ?? 0) > 0;

  // The header pill used to be a hardcoded "All systems healthy" while the
  // Health card below it computed the same thing from real rows, so a run of
  // failed publishes left a green pill sitting directly above the red count.
  // One derivation, stated once.
  const failedPublishes = allArticles.filter((a) => a.status === "error").length;

  const keywordCount = keywords.length;
  // Keywords that have entered the content workflow. Deliberately NOT labelled
  // "with rank data": that would be a different query against keyword_rankings,
  // and a delta that does not measure what it says is how this codebase keeps
  // ending up with numbers nobody can trace.
  const plannedCount = keywords.filter((k) => k.status !== "new").length;

  // Build per-workspace article counts
  const wsCounts = new Map<string, { total: number; live: number }>();
  for (const a of allArticles) {
    const c = wsCounts.get(a.workspace_id) ?? { total: 0, live: 0 };
    c.total++;
    if (a.status === "live") c.live++;
    wsCounts.set(a.workspace_id, c);
  }

  const totalArticles = allArticles.length;
  const totalLive = allArticles.filter((a) => a.status === "live").length;
  const pendingReviews = allArticles.filter((a) => a.status === "review").length;

  // Plain object for client component (Maps aren't serializable)
  const wsCountsObj = Object.fromEntries(wsCounts);

  // Map workspace lookup
  const wsMap = new Map<string, Workspace>(workspaces.map((w) => [w.id, w]));

  return (
    <>
      <PageHead
        title="Dashboard"
        subtitle={
          <>
            {/* A failed publish is the one thing on this page someone has to
                act on, so it keeps its pill. It only renders when there is
                one: "No failed publishes" is not news. */}
            {failedPublishes > 0 && (
              <StatusPill
                status="error"
                label={`${plural(failedPublishes, "publish", "publishes")} failed`}
              />
            )}
            <span>{plural(workspaces.length, "workspace")}</span>
            <DotSep />
            <span>{plural(totalArticles, "article")} total</span>
          </>
        }
        actions={
          <>
            <ClientActions />
          </>
        }
      />

      <StatStrip
        stats={[
          { label: "Articles published", value: `${totalLive}`, unit: ` / ${totalArticles}`, delta: `${totalLive} live`, deltaType: "pos" },
          {
            label: "Organic traffic",
            value: traffic.hasData ? traffic.currentTotal.toLocaleString() : "—",
            unit: " clicks",
            delta: traffic.hasData
              ? traffic.changePct === null
                ? "no prior period"
                : `${traffic.changePct >= 0 ? "+" : ""}${traffic.changePct}% vs previous 30d`
              : (
                  <ConnectPrompt
                    dense
                    icon="trend"
                    title=""
                    body=""
                    href="/connect"
                    cta="Connect analytics"
                  />
                ),
            deltaType: traffic.changePct != null && traffic.changePct > 0 ? "pos" : undefined,
          },
          {
            label: "Keywords tracked",
            value: keywordCount ? keywordCount.toLocaleString() : "—",
            delta: keywordCount ? (
              `${plannedCount} in the content plan`
            ) : (
              <ConnectPrompt dense icon="keywords" title="" body="" href="/keywords" cta="Run keyword research" />
            ),
          },
          { label: "Pending reviews", value: String(pendingReviews), delta: (() => {
              const n = new Set(allArticles.filter((a) => a.status === "review").map((a) => a.workspace_id)).size;
              return `across ${n} ${n === 1 ? "workspace" : "workspaces"}`;
            })() },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <div className="grid grid-cols-12 gap-4">
          {/* Traffic chart */}
          <Card title="Organic traffic · last 30 days" meta={<Chip label="All workspaces" soft />} className="col-span-8">
            <TrafficChart series={traffic} connected={gscConnected} />
            <div className="flex gap-4 text-[11.5px] text-ink-3 mt-2.5 font-mono">
              <span className="flex items-center gap-1.5">
                <i className="inline-block w-2.5 h-2.5 rounded-sm bg-accent" />Traffic
              </span>
              <span className="flex items-center gap-1.5">
                <i className="inline-block w-2.5 h-0.5 rounded-sm bg-ink-4 mt-[1px]" />Prev period
              </span>
            </div>
          </Card>

          {/* Today's queue */}
          <Card title="Needs your review" meta={`${pendingReviews} waiting`} className="col-span-4" flush>
            <div className="px-2 py-1.5">
              {allArticles
                .filter((a) => a.status === "review")
                .slice(0, 5)
                .map((item) => {
                  const w = wsMap.get(item.workspace_id);
                  return (
                    <div key={item.id} className="flex items-center gap-2.5 px-2.5 py-2.5 rounded-[7px] hover:bg-panel">
                      {w && <Avatar initials={w.initials} color={w.color} size="sm" />}
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] truncate">{item.title}</div>
                        <div className="font-mono text-[10.5px] text-ink-3">{w?.domain ?? "—"}</div>
                      </div>
                      <StatusPill status={item.status} />
                    </div>
                  );
                })}
              {pendingReviews === 0 && (
                <div className="text-[13px] text-ink-3 px-2.5 py-4 text-center">No items in queue</div>
              )}
            </div>
          </Card>

          {/* Workspaces grid */}
          <Card title="Workspaces" className="col-span-12" flush>
            <WorkspaceGrid workspaces={workspaces} counts={wsCountsObj} />
          </Card>

          {/* Recent articles */}
          <Card title="Recent articles" meta={<Link href="/articles"><Button size="sm">View all</Button></Link>} className="col-span-12" flush>
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="text-left font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel">Article</th>
                  <th className="text-left font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel">Workspace</th>
                  <th className="text-left font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel">Status</th>
                  <th className="text-right font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel">Score</th>
                  <th className="text-right font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel">Updated</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((a) => {
                  const w = wsMap.get(a.workspace_id);
                  const dateStr = a.updated_at ? new Date(a.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
                  return (
                    <tr key={a.id} className="hover:[&>td]:bg-panel">
                      <td className="px-3.5 py-3 border-b border-line-soft" style={{ maxWidth: 0 }}>
                        <div className="truncate font-medium">{a.title}</div>
                        <div className="font-mono text-[11px] text-ink-3 mt-0.5">{a.keyword}</div>
                      </td>
                      <td className="px-3.5 py-3 border-b border-line-soft">
                        {w && (
                          <span className="inline-flex items-center gap-2">
                            <Avatar initials={w.initials} color={w.color} size="sm" />
                            {w.name}
                          </span>
                        )}
                      </td>
                      <td className="px-3.5 py-3 border-b border-line-soft">
                        <StatusPill status={a.status} />
                      </td>
                      <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">
                        {a.seo_score || "—"}
                      </td>
                      <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">
                        {dateStr}
                      </td>
                    </tr>
                  );
                })}
                {recent.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3.5 py-8 text-center text-ink-3 text-[13px]">No articles yet</td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>

        </div>
      </div>
    </>
  );
}
