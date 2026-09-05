import type { Metadata } from "next";
import Link from "next/link";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getKeywords, getLatestRankings, getSelectionReasonsByKeyword, type KeywordRationale, type LatestRanking } from "@/lib/queries/keywords";
import { loadGscRows } from "@/lib/gsc/queries";
import { queryStats, WINDOW_DAYS, type QueryStat } from "@/lib/gsc/analysis";
import { PageHead, StatusPill, Avatar, Chip, Card, StatStrip, DotSep } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";
import { KeywordActions } from "@/components/dashboard/keyword-actions";
import { KeywordFilters } from "@/components/dashboard/keyword-filters";
import { KeywordPlanButton } from "@/components/dashboard/keyword-plan-button";
import { HowItWorks } from "@/components/dashboard/how-it-works";
import { keywordsExplainer } from "@/lib/explainers";
import type { Workspace } from "@/lib/types";
import { plural } from "@/lib/utils";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";

export const metadata: Metadata = { title: "Keywords" };

type Props = {
  searchParams: Promise<{ status?: string; intent?: string; q?: string; view?: string }>;
};

/**
 * Positions 11-20: one good revision from page one, the band
 * lib/seo/recommendations.ts weights highest. Same numbers, same reading.
 */
const STRIKING_MIN = 11;
const STRIKING_MAX = 20;

function striking(position: number | null): boolean {
  return position !== null && position >= STRIKING_MIN && position <= STRIKING_MAX;
}

/**
 * Case-insensitive substring match across the fields a person would actually
 * type. Applied on the server, next to the data, so the filter bar only has to
 * own the URL.
 */
function matchesQuery(fields: (string | null | undefined)[], q: string): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  return fields.some((f) => (f ?? "").toLowerCase().includes(needle));
}

export default async function KeywordsPage({ searchParams }: Props) {
  // Every section is about one site unless the switcher says otherwise.
  const scopeId = await getScopedWorkspaceId();
  const params = await searchParams;

  // The ranking view is per site: it reads keyword_rankings and Search Console
  // rows, both of which describe one property. Without a scope it is not
  // offered, and the URL asking for it is answered with the reason.
  const ranking = params.view === "ranking" && Boolean(scopeId);

  const [workspaces, keywords] = await Promise.all([
    getWorkspaces(),
    getKeywords(scopeId ?? undefined, params.status, params.intent),
  ]);

  let latest = new Map<string, LatestRanking>();
  let gscByTerm = new Map<string, QueryStat>();
  let rationale = new Map<string, KeywordRationale>();
  let gscConnected = false;
  if (ranking && scopeId) {
    const supabase = await createClient();
    const [rankings, rows, reasons, conn] = await Promise.all([
      getLatestRankings(keywords.map((k) => k.id)),
      loadGscRows(scopeId),
      getSelectionReasonsByKeyword(scopeId),
      supabase.from("workspace_integrations").select("id", { count: "exact", head: true }).eq("workspace_id", scopeId).eq("integration_id", "gsc"),
    ]);
    latest = rankings;
    gscByTerm = queryStats(rows, new Date());
    rationale = reasons;
    gscConnected = (conn.count ?? 0) > 0;
  }

  const wsMap = new Map<string, Workspace>(workspaces.map((w) => [w.id, w]));
  const shown = keywords.filter((k) => matchesQuery([k.term], params.q ?? ""));

  const shippedCount = keywords.filter((k) => k.status === "shipped").length;
  const newCount = keywords.filter((k) => k.status === "new").length;
  const scored = keywords
    .map((k) => k.difficulty)
    .filter((d): d is number => typeof d === "number");

  return (
    <>
      <PageHead
        title="Keywords"
        // Said "Across all workspaces" long after the query stopped being
        // across all workspaces. The list is scoped to the switcher, so the
        // subtitle now names the site it is actually showing, like Articles.
        subtitle={
          <>
            <span>{plural(shown.length, "keyword")}</span>
            {wsMap.get(scopeId ?? "")?.domain ? (
              <>
                <DotSep />
                <span className="font-mono text-[11.5px]">{wsMap.get(scopeId ?? "")?.domain}</span>
              </>
            ) : null}
          </>
        }
        actions={
          <>
            <HowItWorks explainer={keywordsExplainer} />
            <KeywordActions workspaces={workspaces} keywords={keywords} />
          </>
        }
      />

      <StatStrip
        stats={[
          { label: "Tracked", value: keywords.length.toLocaleString(), delta: `${newCount} new`, deltaType: newCount > 0 ? "pos" : undefined },
          { label: "Shipped", value: shippedCount.toLocaleString(), delta: "articles live" },
          // Averaged over keywords that actually have a difficulty. Counting
          // unknowns as 0 dragged the average toward "easy" in proportion to
          // how little we knew.
          { label: "Avg difficulty", value: scored.length > 0 ? Math.round(scored.reduce((s, d) => s + d, 0) / scored.length) : "—" },
          {
            label: "Unscored",
            value: String(keywords.length - scored.length),
            delta: scored.length === keywords.length ? "all have difficulty" : "no difficulty reading",
          },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <KeywordFilters rankingAvailable={Boolean(scopeId)} />

        {params.view === "ranking" && !scopeId && (
          <div className="mb-4 rounded-[9px] border border-line bg-panel px-4 py-3 text-[13px] text-ink-3">
            Rankings belong to one site. Pick a workspace in the sidebar to see positions, clicks and impressions for its keywords.
          </div>
        )}
        {ranking && !gscConnected && (
          <div className="mb-4 rounded-[9px] border border-line bg-panel px-4 py-3 text-[13px] text-ink-3">
            Search Console is not connected for this workspace, so clicks and impressions stay “—”. Positions come from the rank tracker where it has run.
          </div>
        )}

        {ranking ? (
        <Card flush>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {["Keyword", "Tracked pos.", "GSC pos.", `Clicks ${WINDOW_DAYS}d`, `Impr. ${WINDOW_DAYS}d`, "Signal", "Why", "Status"].map((h, i) => (
                  <th key={h || i} className={`font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel ${["Tracked pos.", "GSC pos.", `Clicks ${WINDOW_DAYS}d`, `Impr. ${WINDOW_DAYS}d`].includes(h) ? "text-right" : "text-left"}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((k) => {
                const tracked = latest.get(k.id) ?? null;
                const gsc = gscByTerm.get(k.term.trim().toLowerCase()) ?? null;
                // Tracked position first: it is a SERP check for this term. The
                // Search Console average is the fallback, and the badge says
                // which one it read.
                const strikingFrom = striking(tracked?.position ?? null) ? "tracked" : striking(gsc?.position ?? null) ? "gsc" : null;
                const why = rationale.get(k.id) ?? null;
                const numCell = "px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2 tabular-nums";
                return (
                  <tr key={k.id} className="hover:[&>td]:bg-panel">
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <span className="font-mono text-[13px] text-ink font-medium">{k.term}</span>
                    </td>
                    <td className={numCell} title={tracked ? `Checked ${new Date(tracked.checked_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}${tracked.url ? ` · ${tracked.url}` : ""}` : "The rank tracker has not checked this term"}>
                      {tracked ? (tracked.position === null ? <span className="text-ink-4" title="Checked, not in the results">not ranking</span> : `#${tracked.position}`) : "—"}
                    </td>
                    <td className={numCell} title={gsc ? `Impression-weighted average position over ${WINDOW_DAYS} days` : gscConnected ? "Google reported no impressions for this exact query" : "Search Console not connected"}>
                      {gsc?.position != null ? gsc.position.toFixed(1) : "—"}
                    </td>
                    <td className={numCell}>{gsc ? gsc.clicks.toLocaleString() : "—"}</td>
                    <td className={numCell}>{gsc ? gsc.impressions.toLocaleString() : "—"}</td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      {strikingFrom && (
                        <span
                          className="inline-flex items-center px-[7px] py-px rounded-full text-[11px] font-medium whitespace-nowrap bg-accent-soft text-accent-ink"
                          title={`Position ${STRIKING_MIN}–${STRIKING_MAX}, from ${strikingFrom === "tracked" ? "the rank tracker" : "Search Console's average position"}: one revision from page one.`}
                        >
                          Striking distance
                        </span>
                      )}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-[12px] text-ink-3" style={{ maxWidth: 0, minWidth: 220 }}>
                      {why ? (
                        <Link href={`/content/${why.articleId}`} className="block truncate hover:text-accent-ink" title={why.reasons.join(" · ")}>
                          {why.reasons[0]}{why.reasons.length > 1 ? ` · +${why.reasons.length - 1}` : ""}
                        </Link>
                      ) : (
                        <span className="text-ink-4" title="Only the autonomous queue records why it chose a keyword">—</span>
                      )}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <StatusPill status={k.status} />
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3.5 py-8 text-center text-ink-3">No keywords yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
        ) : (
        <Card flush>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {["Keyword", ...(scopeId ? [] : ["Workspace"]), "Intent", "Volume", "Difficulty", "Status", ""].map((h, i) => (
                  <th key={h || i} className={`font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel ${h === "Volume" ? "text-right" : "text-left"}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((k) => {
                const w = wsMap.get(k.workspace_id);
                const known = typeof k.difficulty === "number";
                const diffColor = !known
                  ? "var(--line)"
                  : k.difficulty! < 25 ? "var(--ok)" : k.difficulty! < 50 ? "var(--warn)" : "var(--err)";
                return (
                  <tr key={k.id} className="hover:[&>td]:bg-panel">
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <span className="font-mono text-[13px] text-ink font-medium">{k.term}</span>
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
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <Chip label={k.intent} soft />
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">
                      {/* null = the provider had no data (research writes it that way); 0 is the pre-054 default. Neither is a measurement. */}
                      {typeof k.volume === "number" && k.volume > 0 ? k.volume.toLocaleString() : <span className="text-ink-4" title="No search volume data">—</span>}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <div className="flex items-center gap-2 justify-end">
                        <div className="w-[60px] h-[5px] bg-panel-2 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: known ? `${k.difficulty}%` : "0%", background: diffColor }} />
                        </div>
                        <span
                          className={`font-mono text-[11px] w-5 text-right ${known ? "" : "text-ink-4"}`}
                          title={known ? undefined : "No difficulty data from the keyword provider"}
                        >
                          {known ? k.difficulty : "—"}
                        </span>
                      </div>
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <StatusPill status={k.status} />
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <KeywordPlanButton keywordId={k.id} currentStatus={k.status} />
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3.5 py-10 text-center text-ink-3">
                    {keywords.length === 0 ? (
                      <span className="inline-block max-w-[56ch] leading-[1.6]">
                        No keywords yet. The first analysis of a site fills this from what it already ranks for, what
                        competitors rank for that it does not, and phrases seeded from its own pages. Add one by hand
                        with Research keywords; the nightly analysis run adds more as the site is read.
                      </span>
                    ) : (
                      <>No keyword matches these filters.</>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
        )}
      </div>
    </>
  );
}
