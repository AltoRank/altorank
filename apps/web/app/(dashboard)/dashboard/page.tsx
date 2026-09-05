import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getRecentArticles, getArticles } from "@/lib/queries/articles";
import { getKeywords, getKeywordSourceYields } from "@/lib/queries/keywords";
import { knownPagesFor, loadGscRows, syncHealthFor, type SyncHealth } from "@/lib/gsc/queries";
import {
  cannibalization,
  indexCoverage,
  queryOpportunities,
  searchPerformance,
  servedUrls,
  topPages,
  WINDOW_DAYS,
} from "@/lib/gsc/analysis";
import {
  BestArticlesBlock,
  CannibalizationBlock,
  DataFreshness,
  IndexCoverageBlock,
  OpportunitiesList,
  SearchPerformanceBlock,
  describeChange,
} from "@/components/dashboard/gsc-blocks";
import { getTrafficValue } from "@/lib/queries/value";
import { describeOrganicValue, formatOrganicValue } from "@/lib/analytics/value";
import { getBingSummary } from "@/lib/queries/bing";
import { PageHead, DotSep, StatusPill, Avatar, Icons, Button, Chip, Card, StatStrip, ConnectPrompt } from "@/components/ui";
import { ClientActions } from "@/components/dashboard/client-actions";
import { ShareResults } from "@/components/dashboard/share-results";
import { getShareCardFacts } from "@/lib/queries/share";
import { buildShareCard } from "@/lib/share/card";
import { WorkspaceGrid } from "@/components/dashboard/workspace-grid";
import { RecommendedActionsStrip } from "@/components/dashboard/recommended-actions-strip";
import { recommendedActions } from "@/lib/dashboard/recommended-actions";
import { yieldsForInputs, type KeywordSourceYields } from "@/lib/keywords/yields";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import type { Workspace } from "@/lib/types";
import { plural } from "@/lib/utils";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * The Search Console chart and the blocks under it live in
 * components/dashboard/gsc-blocks.tsx. Every number there is read from rows
 * the nightly sync stored and shown as measured; the locked and not-yet-synced
 * states are worded once, in GscGate, and the chart renders nothing rather
 * than a flat line when there is nothing measured to draw.
 */
export default async function DashboardPage() {
  // Every section is about one site unless the switcher says otherwise.
  const scopeId = await getScopedWorkspaceId();
  // Whether any workspace has Google connected at all: it changes the empty
  // state from an instruction into an explanation. Independent of the five
  // reads beside it, so it runs with them instead of after them.
  const gscSupabase = await createClient();
  // Scoped like everything else on this page: connections live per workspace,
  // so an unscoped count said "GSC connected" on the strength of a different
  // client's account.
  let gscQuery = gscSupabase
    .from("workspace_integrations")
    .select("id", { count: "exact", head: true })
    .eq("integration_id", "gsc");
  if (scopeId) gscQuery = gscQuery.eq("workspace_id", scopeId);

  // A CMS on this workspace: the difference between "approved" meaning
  // "published" and meaning "a draft with a green label".
  let cmsQuery = gscSupabase
    .from("workspace_integrations")
    .select("id, integration:integrations(tag)");
  if (scopeId) cmsQuery = cmsQuery.eq("workspace_id", scopeId);

  let plannedQuery = gscSupabase
    .from("calendar_entries")
    .select("id", { count: "exact", head: true })
    .eq("status", "queue")
    .is("article_id", null);
  if (scopeId) plannedQuery = plannedQuery.eq("workspace_id", scopeId);

  const now = new Date();
  const [workspaces, allArticles, recent, gscRows, keywords, { count: gscCount }, bing, cmsRes, { count: plannedEntries }, yields, profileRes, health, knownPages, shareFacts, value] =
    await Promise.all([
      getWorkspaces(),
      getArticles(scopeId ?? undefined),
      getRecentArticles(6, scopeId ?? undefined),
      // One read of the two Search Console windows feeds the chart, the
      // stat, best articles, cannibalisation and coverage below.
      loadGscRows(scopeId ?? undefined, now),
      getKeywords(scopeId ?? undefined),
      gscQuery,
      // Bing, kept beside the chart rather than in it: two engines summed into
      // one line would be a number that describes neither.
      getBingSummary(scopeId ?? undefined),
      cmsQuery,
      plannedQuery,
      scopeId ? getKeywordSourceYields(scopeId) : Promise.resolve<KeywordSourceYields | null>(null),
      scopeId
        ? gscSupabase.from("workspaces").select("business_profile").eq("id", scopeId).maybeSingle()
        : Promise.resolve({ data: null }),
      // Per-site by nature: a sync time and a page inventory across several
      // sites would be two numbers describing none of them.
      scopeId ? syncHealthFor(scopeId) : Promise.resolve<SyncHealth | null>(null),
      scopeId ? knownPagesFor(scopeId) : Promise.resolve(null),
      // The share card: measured facts for this site, or nothing to share.
      scopeId ? getShareCardFacts(scopeId) : Promise.resolve(null),
      // The same clicks as the chart, priced. The one figure on this page
      // that is an estimate, and its label and tooltip say so.
      getTrafficValue(scopeId ?? undefined),
    ]);
  const traffic = searchPerformance(gscRows, now);
  const bestPages = scopeId ? topPages(gscRows, now) : [];
  const cannibals = scopeId ? cannibalization(gscRows, now) : [];
  const opportunities = scopeId ? queryOpportunities(gscRows, now, WINDOW_DAYS, 6) : [];
  const coverage = knownPages ? indexCoverage(knownPages, servedUrls(gscRows, now)) : null;
  const gscConnected = (gscCount ?? 0) > 0;
  // Same test the Articles page applies: any connected integration tagged CMS.
  const cmsConnected = (cmsRes.data ?? []).some(
    (r) => ((r as { integration?: { tag?: string } | null }).integration?.tag ?? null) === "CMS",
  );
  const profile = (profileRes.data?.business_profile as BusinessProfile | null) ?? null;

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

  const actions = recommendedActions({
    cmsConnected,
    gscConnected,
    pendingReviews,
    scheduledCount: plannedEntries ?? 0,
  });
  const competitorYields = yields ? yieldsForInputs(profile?.competitors ?? [], "competitor", yields) : [];
  const audienceYields = yields ? yieldsForInputs(profile?.audiences ?? [], "audience", yields) : [];

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
            <span>{scopeId ? (workspaces.find((w) => w.id === scopeId)?.domain ?? "one workspace") : plural(workspaces.length, "workspace")}</span>
            <DotSep />
            <span>{plural(totalArticles, "article")} total</span>
          </>
        }
        actions={
          <>
            {shareFacts && scopeId && (
              <ShareResults card={buildShareCard(shareFacts)} ogPath={`/api/og/workspace/${scopeId}`} />
            )}
            <ClientActions />
          </>
        }
      />

      <StatStrip
        stats={[
          { label: "Articles published", value: `${totalLive}`, unit: ` / ${totalArticles}`, delta: `${totalLive} live`, deltaType: "pos" },
          {
            label: "Organic traffic",
            value: traffic.hasData ? traffic.clicks.current.toLocaleString() : "—",
            unit: " clicks",
            hint: `Clicks Google reported for the last ${traffic.days} days, ending yesterday. Nothing here is estimated.`,
            // A synced zero keeps its "0", because nobody clicking IS the
            // measurement; the delta says what Google did report, so the row
            // does not read as a broken integration.
            delta: traffic.hasData
              ? !traffic.hasClicks
                ? traffic.impressions.current
                  ? `${traffic.impressions.current.toLocaleString()} impressions, no clicks yet`
                  : "no impressions reported yet"
                : describeChange(traffic.clicks, traffic.days, "clicks")
              : gscConnected
                ? "connected · Google has not returned rows yet"
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
            deltaType: traffic.clicks.changePct != null && traffic.clicks.changePct > 0 ? "pos" : undefined,
          },
          {
            label: "Est. traffic value",
            // Dollars written the way the scoped site's locale writes them;
            // the all-sites view has no single locale and uses English.
            value: formatOrganicValue(value.value, scopeId ? wsMap.get(scopeId)?.language : "en"),
            hint: describeOrganicValue(value, value.days),
            // What the number leaves out, in the same breath. An estimate
            // that covers a fifth of the clicks must not be read as the whole.
            delta:
              value.value === null
                ? value.clicks > 0
                  ? "no cost-per-click on file yet"
                  : traffic.hasData
                    ? "no priced clicks yet"
                    : "needs Search Console"
                : value.coverage === null
                  ? "priced, no clicks yet"
                  : `covers ${Math.round(value.coverage * 100)}% of ${value.clicks.toLocaleString()} clicks`,
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
        <RecommendedActionsStrip actions={actions} />
        <div className="grid grid-cols-12 gap-4">
          {/* Traffic chart */}
          <Card title={`Search performance · last ${traffic.days} days`} meta={<Chip label={scopeId ? (workspaces.find((w) => w.id === scopeId)?.name ?? "This workspace") : "All workspaces"} soft />} className="col-span-8">
            <SearchPerformanceBlock perf={traffic} connected={gscConnected} />
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-3 mt-2.5 font-mono">
              <span className="flex items-center gap-1.5">
                <i className="inline-block w-2.5 h-2.5 rounded-sm bg-accent" />Current {traffic.days}d
              </span>
              {traffic.previousMeasured ? (
                <span className="flex items-center gap-1.5">
                  <i className="inline-block w-2.5 h-0.5 rounded-sm bg-ink-4 mt-[1px]" />Previous {traffic.days}d
                </span>
              ) : traffic.hasData ? (
                <span className="text-ink-4">Previous period not synced yet</span>
              ) : null}
              {traffic.hasData && traffic.previousMeasured && (
                <span className="text-ink-3">
                  impressions {describeChange(traffic.impressions, traffic.days, "impressions")}
                </span>
              )}
              {bing.connected && (
                <span className="ml-auto text-ink-3">
                  {bing.hasData
                    ? `Bing · ${bing.clicks.toLocaleString()} clicks · ${bing.impressions.toLocaleString()} impressions, ${bing.days}d`
                    : "Bing connected · nothing reported yet"}
                </span>
              )}
            </div>
            {/* When the rows were written and when the next batch lands.
                "Never" is what a fresh connection honestly says. */}
            <div className="mt-2">
              <DataFreshness health={health} now={now} />
            </div>
            {gscConnected && traffic.hasData && <OpportunitiesList opportunities={opportunities} />}
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

          {/* The Search Console blocks. Per site only: each is about one
              property, and the page has no honest way to add two of them. */}
          {scopeId && coverage && (
            <>
              <Card title={`Best articles · last ${traffic.days} days`} meta="clicks per page, Google's count" className="col-span-7" flush>
                <BestArticlesBlock pages={bestPages} connected={gscConnected} hasData={traffic.hasData} days={traffic.days} />
              </Card>
              <Card title="Index coverage" meta="from what we hold" className="col-span-5" flush>
                <IndexCoverageBlock coverage={coverage} connected={gscConnected} hasData={traffic.hasData} />
              </Card>
              <Card
                title="Cannibalization"
                meta={cannibals.length > 0 ? `${plural(cannibals.length, "query", "queries")} with competing pages` : "queries with two or more of your pages ranking"}
                className="col-span-12"
                flush
              >
                <CannibalizationBlock items={cannibals} connected={gscConnected} hasData={traffic.hasData} days={traffic.days} />
              </Card>
            </>
          )}

          {/* Where the keywords came from and what each source produced.
              Counts only: a zero beside a competitor is a real finding (that
              rival shares no keywords with this site), and there is no metric
              here that could be mistaken for one. */}
          {yields && (
            <Card title="Keyword sources" meta={<Link href="/keywords"><Button size="sm">Keywords</Button></Link>} className="col-span-12" flush>
              <StatStrip
                compact
                stats={[
                  { label: "Total", value: yields.total.toLocaleString() },
                  { label: "Scheduled", value: yields.scheduled.toLocaleString(), delta: "planned, not yet written" },
                  { label: "Written", value: yields.written.toLocaleString(), delta: "with at least one article" },
                  { label: "Stored", value: yields.stored.toLocaleString(), delta: "tracked, not on the plan" },
                ]}
              />
              <div className="grid grid-cols-2 gap-x-8 px-6 py-4 text-[13px]">
                <div>
                  <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3 mb-2">Competitor effectiveness</div>
                  {competitorYields.length === 0 ? (
                    <div className="text-ink-3">No competitors named in the business profile, and no keyword came from one.</div>
                  ) : (
                    <ul className="space-y-1">
                      {competitorYields.map((c) => (
                        <li key={c.input} className="flex items-baseline justify-between gap-3">
                          <span className="font-mono text-[12px] text-ink-2 truncate">{c.input}</span>
                          <span className={`shrink-0 font-mono text-[12px] ${c.keywords === 0 ? "text-ink-3" : "text-ink"}`}>
                            {plural(c.keywords, "keyword")}{c.articles > 0 ? ` · ${plural(c.articles, "article")}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3 mb-2">Audience effectiveness</div>
                  {audienceYields.length === 0 ? (
                    <div className="text-ink-3">No audiences named in the business profile, and no keyword came from one.</div>
                  ) : (
                    <ul className="space-y-1">
                      {audienceYields.map((a) => (
                        <li key={a.input} className="flex items-baseline justify-between gap-3">
                          <span className="text-ink-2 truncate">{a.input}</span>
                          <span className={`shrink-0 font-mono text-[12px] ${a.keywords === 0 ? "text-ink-3" : "text-ink"}`}>
                            {plural(a.keywords, "keyword")}{a.articles > 0 ? ` · ${plural(a.articles, "article")}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </Card>
          )}

          {/* The roster belongs to the all-workspaces view. Scoped to one
              site, a grid of every other site is noise on the page that is
              supposed to be about this one (2026-09-02). */}
          {!scopeId && (
            <Card title="Workspaces" className="col-span-12" flush>
              <WorkspaceGrid workspaces={workspaces} counts={wsCountsObj} />
            </Card>
          )}

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
