import Link from "next/link";
import { ConnectPrompt } from "@/components/ui";
import type {
  Cannibalization,
  CoverageBucket,
  IndexCoverage,
  PageStat,
  QueryStat,
  SearchPerformance,
} from "@/lib/gsc/analysis";
import { shortUrl } from "@/lib/gsc/analysis";
import { nextSyncClock, relativeTime } from "@/lib/gsc/freshness";
import type { SyncHealth } from "@/lib/gsc/queries";
import { plural } from "@/lib/utils";

/**
 * The Search Console blocks. Server components, no state: every number
 * arrives measured from lib/gsc/analysis and is rendered as it is, with
 * null shown as a dash. Each block has three honest states - not connected,
 * connected with nothing returned yet, and data - and `GscGate` is the one
 * place those two empty states are worded.
 */

type GateProps = {
  connected: boolean;
  /** Any Search Console row at all for this workspace. */
  hasData: boolean;
  /** Short name of what the block would show, for the locked-state sentence. */
  children: React.ReactNode;
  /** Compact variant for a card that is a list rather than a chart. */
  dense?: boolean;
};

export function GscGate({ connected, hasData, children, dense = false }: GateProps) {
  if (!connected) {
    return (
      <div className={dense ? "py-2" : "min-h-[220px] grid place-items-center"}>
        <ConnectPrompt
          icon="trend"
          service="Google Search Console"
          title="Without Search Console we cannot show real search data here"
          body="Nothing in this block is estimated. Connect Search Console and the daily sync fills it with what Google actually reports."
          href="/connect"
          cta="Connect Search Console"
        />
      </div>
    );
  }
  if (!hasData) {
    const at = nextSyncClock();
    return (
      <div className={`${dense ? "py-6" : "min-h-[220px]"} grid place-items-center px-8 text-center`}>
        <div className="max-w-[46ch] text-[13px] leading-relaxed text-ink-3">
          <div className="mb-1 text-[13.5px] font-medium text-ink-2">Connected. Google has not returned rows yet</div>
          {at ? `The first sync runs at ${at}.` : "No sync is scheduled; check vercel.json."} Search Console reports with
          about a two-day lag, and if this stays empty, Integrations says whether the connected Google account can see a
          property for this domain.
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Search performance
// ---------------------------------------------------------------------------

function pathFor(values: number[], W: number, H: number, pad: number, max: number) {
  const x = (i: number) => pad + (i * (W - pad * 2)) / Math.max(values.length - 1, 1);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  return {
    x,
    y,
    line: values.map((v, i) => `${i ? "L" : "M"} ${x(i)} ${y(v)}`).join(" "),
  };
}

function Series({ label, current, previous, gradientId }: { label: string; current: number[]; previous: number[]; gradientId: string }) {
  const W = 900, H = 110, pad = 14;
  // Guard the all-zero case: a max of 0 makes every y NaN and the path vanishes.
  const max = Math.max(...current, ...previous, 1) * 1.1;
  const cur = pathFor(current, W, H, pad, max);
  const prev = pathFor(previous, W, H, pad, max);
  const area = `${cur.line} L ${cur.x(current.length - 1)} ${H - pad} L ${cur.x(0)} ${H - pad} Z`;
  const total = current.reduce((a, b) => a + b, 0);
  return (
    <div>
      <div className="flex items-baseline justify-between font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3 mb-1">
        <span>{label}</span>
        <span className="text-ink-2 normal-case tracking-normal text-[11.5px]">{total.toLocaleString()}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="96" preserveAspectRatio="none" role="img" aria-label={`${label}, daily, current window against the previous one`}>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.18" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1={pad} x2={W - pad} y1={pad + f * (H - pad * 2)} y2={pad + f * (H - pad * 2)} stroke="var(--line-soft)" strokeWidth="1" />
        ))}
        <path d={area} fill={`url(#${gradientId})`} />
        <path d={prev.line} fill="none" stroke="var(--ink-4)" strokeWidth="1.5" strokeDasharray="4 4" />
        <path d={cur.line} fill="none" stroke="var(--accent)" strokeWidth="2" />
      </svg>
    </div>
  );
}

/**
 * Clicks and impressions, each on its own axis. One chart with two lines
 * would put a number in the hundreds beside one in the tens of thousands
 * and flatten the one that matters.
 */
export function SearchPerformanceBlock({ perf, connected }: { perf: SearchPerformance; connected: boolean }) {
  return (
    <GscGate connected={connected} hasData={perf.hasData}>
      {!perf.hasClicks && perf.impressions.current === 0 && (perf.impressions.previous ?? 0) === 0 ? (
        // Synced, and the measurement is zero. Drawing a flat line would be a
        // claim about the site rather than about the data.
        <div className="min-h-[220px] grid place-items-center px-8 text-center">
          <div className="max-w-[46ch] text-[13px] leading-relaxed text-ink-3">
            <div className="mb-1 text-[13.5px] font-medium text-ink-2">Measured, and there is nothing to plot yet</div>
            Search Console reported no impressions and no clicks over the last {perf.days} days, so there is nothing to
            draw. That is a measurement, not a gap in the data. Nothing here is estimated.
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          <Series label="Clicks" current={perf.current.map((p) => p.clicks)} previous={perf.previous.map((p) => p.clicks)} gradientId="gsc-clicks" />
          <Series label="Impressions" current={perf.current.map((p) => p.impressions)} previous={perf.previous.map((p) => p.impressions)} gradientId="gsc-impressions" />
          {!perf.hasClicks && (
            <p className="text-[12px] text-ink-3">
              {perf.impressions.current.toLocaleString()} impressions and no clicks over the last {perf.days} days. Impressions
              mean the pages are being shown; clicks follow position. Nothing here is estimated.
            </p>
          )}
        </div>
      )}
    </GscGate>
  );
}

/** "+12% vs previous 28d", "no prior period", or the raw delta when the baseline is zero. */
export function describeChange(c: { current: number; previous: number | null; changePct: number | null }, days: number, unit: string): string {
  if (c.previous === null) return "no prior period synced";
  if (c.changePct !== null) return `${c.changePct >= 0 ? "+" : ""}${c.changePct}% vs previous ${days}d`;
  return `${c.previous.toLocaleString()} ${unit} in the previous ${days}d`;
}

// ---------------------------------------------------------------------------
// Data freshness
// ---------------------------------------------------------------------------

export function DataFreshness({ health, now = new Date() }: { health: SyncHealth | null; now?: Date }) {
  if (!health?.connected) return null;
  const next = nextSyncClock(now);
  return (
    <div className="font-mono text-[11px] text-ink-3" title={health.latestMetricDate ? `Newest day reported by Google: ${health.latestMetricDate}` : undefined}>
      Search Console synced {relativeTime(health.lastSyncAt, now)}
      {next ? `; next sync ${next}` : ""}
      {health.siteUrl ? ` · ${health.siteUrl}` : ""}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Best articles
// ---------------------------------------------------------------------------

const th = "font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel";
const td = "px-3.5 py-2.5 border-b border-line-soft";
const num = `${td} text-right font-mono text-xs text-ink-2 tabular-nums`;

function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className="text-ink-4" title="The previous window was never synced">—</span>;
  if (value === 0) return <span className="text-ink-3">±0</span>;
  return <span className={value > 0 ? "text-ok-ink" : "text-err-ink"}>{value > 0 ? "+" : "−"}{Math.abs(value).toLocaleString()}</span>;
}

export function BestArticlesBlock({ pages, connected, hasData, days }: { pages: PageStat[]; connected: boolean; hasData: boolean; days: number }) {
  return (
    <GscGate connected={connected} hasData={hasData} dense>
      {pages.length === 0 ? (
        <div className="px-3.5 py-6 text-center text-[13px] text-ink-3">
          Google reported no page with a click or an impression in the last {days} days.
        </div>
      ) : (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={`${th} text-left`}>Page</th>
              <th className={`${th} text-right`}>Clicks</th>
              <th className={`${th} text-right`}>vs prev</th>
              <th className={`${th} text-right`}>Impr.</th>
              <th className={`${th} text-right`}>Pos.</th>
            </tr>
          </thead>
          <tbody>
            {pages.map((p) => (
              <tr key={p.url} className="hover:[&>td]:bg-panel">
                <td className={td} style={{ maxWidth: 0 }}>
                  {p.articleId ? (
                    <Link href={`/content/${p.articleId}`} className="block truncate font-mono text-[12px] hover:text-accent-ink hover:underline decoration-line underline-offset-[3px]" title={p.url}>
                      {shortUrl(p.url)}
                    </Link>
                  ) : (
                    <a href={p.url} target="_blank" rel="noopener noreferrer" className="block truncate font-mono text-[12px] text-ink-2" title={`${p.url} (not written here)`}>
                      {shortUrl(p.url)}
                    </a>
                  )}
                </td>
                <td className={num}>{p.clicks.toLocaleString()}</td>
                <td className={num}><Delta value={p.clicksDelta} /></td>
                <td className={num}>{p.impressions.toLocaleString()}</td>
                <td className={num}>{p.position === null ? "—" : p.position.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </GscGate>
  );
}

// ---------------------------------------------------------------------------
// Query opportunities
// ---------------------------------------------------------------------------

export function OpportunitiesList({ opportunities }: { opportunities: QueryStat[] }) {
  if (opportunities.length === 0) return null;
  return (
    <div className="mt-4 border-t border-line-soft pt-3">
      <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3 mb-2">One push from page one · positions 4–15</div>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12.5px]">
        {opportunities.map((q) => (
          <li key={q.query} className="flex items-baseline justify-between gap-3">
            <span className="truncate text-ink-2">{q.query}</span>
            <span className="shrink-0 font-mono text-[11.5px] text-ink-3 tabular-nums">
              #{q.position?.toFixed(1)} · {q.impressions.toLocaleString()} impr · {q.clicks} clicks
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cannibalization
// ---------------------------------------------------------------------------

export function CannibalizationBlock({ items, connected, hasData, days }: { items: Cannibalization[]; connected: boolean; hasData: boolean; days: number }) {
  return (
    <GscGate connected={connected} hasData={hasData} dense>
      {items.length === 0 ? (
        <div className="px-3.5 py-6 text-center text-[13px] text-ink-3">
          No query in the last {days} days had two of this site&apos;s pages ranking for it. That is a measurement over the
          query-and-page rows Google returned, not a guess.
        </div>
      ) : (
        <div className="divide-y divide-line-soft">
          {items.map((c) => (
            <div key={c.query} className="px-[18px] py-3.5">
              <div className="flex items-baseline justify-between gap-3 mb-2">
                <div className="font-mono text-[13px] font-medium text-ink truncate">{c.query}</div>
                <div className="shrink-0 font-mono text-[11.5px] text-ink-3 tabular-nums">
                  {plural(c.pages.length, "page")} · {c.impressions.toLocaleString()} impr · {c.clicks} clicks
                </div>
              </div>
              <ul className="grid gap-1 mb-2">
                {c.pages.map((p) => (
                  <li key={p.url} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                    <span className="truncate">
                      {p.articleId ? (
                        <Link href={`/content/${p.articleId}`} className="font-mono text-[12px] hover:text-accent-ink hover:underline decoration-line underline-offset-[3px]" title={p.url}>
                          {shortUrl(p.url)}
                        </Link>
                      ) : (
                        <span className="font-mono text-[12px] text-ink-2" title={p.url}>{shortUrl(p.url)}</span>
                      )}
                      {p.url === c.winner.url && <span className="ml-2 text-[10.5px] uppercase tracking-[0.06em] text-ok-ink">winner</span>}
                    </span>
                    <span className="shrink-0 font-mono text-[11.5px] text-ink-3 tabular-nums">
                      {p.position === null ? "—" : `#${p.position.toFixed(1)}`} · {p.impressions.toLocaleString()} impr · {p.clicks} clicks
                    </span>
                  </li>
                ))}
              </ul>
              {/* Words, not buttons. Merging or rewriting a page is a decision
                  with consequences on a live site; the block says what the
                  numbers suggest and stops there. */}
              <ul className="grid gap-0.5">
                {c.suggestions.map((s) => (
                  <li key={s.url} className="text-[12px] text-ink-3 leading-relaxed">
                    <span className={`mr-1.5 font-mono text-[10.5px] uppercase tracking-[0.06em] ${s.action === "merge" ? "text-warn-ink" : "text-ink-2"}`}>{s.action}</span>
                    {s.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </GscGate>
  );
}

// ---------------------------------------------------------------------------
// Index coverage
// ---------------------------------------------------------------------------

export const COVERAGE_LABEL: Record<CoverageBucket, string> = {
  indexed: "Indexed",
  not_indexed: "Not indexed",
  unknown: "Unknown",
};

/** Indexed / Not indexed / Unknown as a small pill, same everywhere it appears. */
export function IndexBadge({ bucket, title }: { bucket: CoverageBucket; title?: string }) {
  const cls =
    bucket === "indexed"
      ? "bg-ok-soft text-ok-ink"
      : bucket === "not_indexed"
        ? "bg-warn-soft text-warn-ink"
        : "border border-line text-ink-3";
  return (
    <span className={`inline-flex items-center px-[7px] py-px rounded-full text-[11px] font-medium whitespace-nowrap ${cls}`} title={title}>
      {COVERAGE_LABEL[bucket]}
    </span>
  );
}

export function IndexCoverageBlock({ coverage, connected, hasData }: { coverage: IndexCoverage; connected: boolean; hasData: boolean }) {
  // Coverage is measured partly without Search Console (URL inspection
  // needs it, but knowing the pages exist does not), so the gate only
  // applies when we hold no measurement of any kind.
  const measured = coverage.indexed + coverage.notIndexed > 0;
  if (coverage.total === 0) {
    return (
      <div className="px-3.5 py-6 text-center text-[13px] text-ink-3">
        No pages known yet: nothing is live and the site has not been crawled.
      </div>
    );
  }
  const cells: Array<{ bucket: CoverageBucket; value: number; note: string }> = [
    { bucket: "indexed", value: coverage.indexed, note: "Google said so, or served the page in search" },
    { bucket: "not_indexed", value: coverage.notIndexed, note: "URL inspection came back excluded or failed" },
    { bucket: "unknown", value: coverage.unknown, note: "known to exist, never inspected, not served in search" },
  ];
  return (
    <div>
      <div className="grid grid-cols-3 gap-px bg-line border-b border-line">
        {cells.map((c) => (
          <div key={c.bucket} className="bg-bg px-4 py-3">
            <div className="mb-1.5"><IndexBadge bucket={c.bucket} /></div>
            <div className="text-[22px] font-semibold tracking-tight text-ink tabular-nums">{c.value}</div>
            <div className="text-[11px] text-ink-3 leading-snug mt-1">{c.note}</div>
          </div>
        ))}
      </div>
      <div className="px-4 py-3 text-[12px] text-ink-3 leading-relaxed">
        {plural(coverage.total, "known page")}: live articles plus the pages the sitemap crawl found.{" "}
        {measured
          ? `${coverage.byInspection} measured by URL inspection, ${coverage.bySearch} by appearing in search.`
          : connected && hasData
            ? "Nothing measured yet: no page has appeared in search and none has been inspected. “Check indexing” on an article asks Google directly."
            : connected
              ? "Search Console is connected but has returned no rows yet, so every page is unknown until it does."
              : "Without Search Console, pages stay unknown until one is inspected. A page that answered our own fetch with a 200 is not indexed for having done so."}
      </div>
    </div>
  );
}
