import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHead, Card, StatStrip } from "@/components/ui";
import { createServiceClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/admin";
import { AdminTabs } from "./admin-tabs";
import { Table } from "./table";
import { PreviewControl } from "./preview-control";
import { getOperatorPreview } from "@/lib/auth/preview";
import { ScheduledWork } from "./scheduled-work";
import {
  forecastAll,
  jobForOperation,
  measuredRatesFromGroups,
  type JobKey,
  type WorkspaceDrivers,
} from "@/lib/billing/forecast";
import { readSpendSummary, sumBy } from "@/lib/admin/spend-summary";
import { readAllPages, type PageResult } from "@/lib/supabase/read-all";

export const metadata: Metadata = { title: "Operations" };

/**
 * What the machine is costing us, per workspace and per provider.
 *
 * Reads across every account, so it is gated on an operator email rather than
 * on account membership, and it uses the service client deliberately: the whole
 * point is the numbers RLS would hide.
 *
 * Every figure here is what a provider reported, never an estimate. A provider
 * that reports no cost shows a dash, because "free" and "did not say" are
 * different facts and averaging them would understate the bill.
 */
export default async function AdminPage() {
  if (!(await isAdmin())) notFound();

  const supabase = createServiceClient();

  // Async Server Component: one render per request, so the read is stable for
  // the render's lifetime. The rule guards client re-renders, which this
  // page never has.
  // eslint-disable-next-line react-hooks/purity
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);

  // Every row, not the first thousand: PostgREST stops at max_rows without a
  // word, and these are summed and counted (lib/supabase/read-all.ts). Spend
  // is summed in the database (lib/admin/spend-summary.ts).
  type WorkspaceRow = {
    id: string;
    domain: string | null;
    status: string | null;
    detected_platform: string | null;
    first_analysed_at: string | null;
    auto_generate: boolean | null;
    auto_generate_weekly_limit: number | null;
    geo_tracking: boolean | null;
  };
  // The builder narrowed to what these reads use: the select strings are
  // built here, and supabase-js cannot type a string it does not see.
  type Page<T> = PromiseLike<PageResult<T>>;
  interface Query<T> {
    in(column: string, values: unknown[]): Query<T>;
    eq(column: string, value: unknown): Query<T>;
    order(column: string): Query<T>;
    range(from: number, to: number): Page<T>;
  }
  const all = <T,>(table: string, columns: string, filter?: (q: Query<T>) => Query<T>) =>
    readAllPages<T>(table, (from, to, count) => {
      const q = supabase.from(table).select(`id, ${columns}`, { count }) as unknown as Query<T>;
      return (filter ? filter(q) : q).order("id").range(from, to);
    });
  const [summary, { data: recentCalls }, workspaces, articles, trackedKw, prompts] = await Promise.all([
    readSpendSummary(supabase, cutoff),
    supabase
      .from("provider_spend")
      .select("provider, operation, cost_usd, workspace_id, created_at")
      .order("created_at", { ascending: false })
      .limit(40),
    all<WorkspaceRow>("workspaces", "domain, status, detected_platform, first_analysed_at, auto_generate, auto_generate_weekly_limit, geo_tracking"),
    all<{ workspace_id: string; status: string; keyword: string | null }>("articles", "workspace_id, status, keyword"),
    // What cron/serp will track: the same status filter it uses.
    all<{ workspace_id: string; term: string }>("keywords", "workspace_id, term", (q) => q.in("status", ["planned", "shipped"])),
    all<{ workspace_id: string }>("geo_prompts", "workspace_id", (q) => q.eq("enabled", true)),
  ]);

  // Null whenever the preview is off, and also for a non-operator, though
  // this page 404s for those before we get here.
  const previewActive = (await getOperatorPreview()) !== null;

  const groups = summary.groups;
  const wsById = new Map(workspaces.map((w) => [w.id, w]));

  const total = groups.reduce((s, g) => s + g.usd, 0);
  const since = summary.firstAt;

  // By provider, and by operation, which is where a spike is actually traceable
  const byProvider = sumBy(groups, (g) => g.provider);
  const byOperation = sumBy(groups, (g) => `${g.provider} · ${g.operation}`);

  // By workspace, with article counts, so cost per article is visible
  const articleCount = new Map<string, number>();
  for (const a of articles) {
    articleCount.set(a.workspace_id, (articleCount.get(a.workspace_id) ?? 0) + 1);
  }
  const byWorkspace = new Map([...sumBy(groups, (g) => g.workspaceId)].map(([k, v]) => [k, v.usd]));

  const usd = (n: number) => `$${n.toFixed(4)}`;

  // --- What the schedule is expected to cost, from the users' settings -----
  // Mirrors cron/serp's tracking rule: planned + shipped keywords, plus any
  // article keyword not already among them, capped in the forecast.
  const trackedByWs = new Map<string, Set<string>>();
  for (const k of trackedKw) {
    const set = trackedByWs.get(k.workspace_id) ?? new Set<string>();
    set.add((k.term as string).toLowerCase());
    trackedByWs.set(k.workspace_id, set);
  }
  for (const a of articles ?? []) {
    if (!a.keyword) continue;
    const set = trackedByWs.get(a.workspace_id) ?? new Set<string>();
    set.add((a.keyword as string).toLowerCase());
    trackedByWs.set(a.workspace_id, set);
  }
  const promptsByWs = new Map<string, number>();
  for (const p of prompts) promptsByWs.set(p.workspace_id, (promptsByWs.get(p.workspace_id) ?? 0) + 1);

  const drivers: WorkspaceDrivers[] = workspaces.map((w) => ({
    id: w.id,
    domain: w.domain ?? "—",
    trackedKeywords: trackedByWs.get(w.id)?.size ?? 0,
    autoGenerate: Boolean(w.auto_generate),
    weeklyLimit: (w.auto_generate_weekly_limit as number | null) ?? null,
    geoTracking: Boolean(w.geo_tracking),
    enabledPrompts: promptsByWs.get(w.id) ?? 0,
    needsFirstLook: !w.first_analysed_at,
  }));

  const { rates, measured } = measuredRatesFromGroups(groups, summary.modelArticles);
  const forecast = forecastAll(drivers, rates);
  const expectedByWs = new Map(forecast.perWorkspace.map((f) => [f.id, f.total]));

  const actual30d: Record<JobKey, number> = { serp: 0, backlinks: 0, generate: 0, geo: 0, analyze: 0 };
  for (const g of groups) {
    if (!g.recent) continue;
    const job = jobForOperation(g.provider, g.operation);
    if (job) actual30d[job] += g.usd;
  }

  return (
    <>
      <PageHead
        title="Operations"
        subtitle={
          <span>
            {summary.calls.toLocaleString()} recorded provider calls
            {since ? ` since ${new Date(since).toLocaleDateString()}` : ""}
          </span>
        }
      />

      <AdminTabs />

      <StatStrip
        stats={[
          { label: "Total spend", value: usd(total), delta: "as reported by providers" },
          {
            label: "Workspaces",
            value: String(workspaces.length),
            delta: `${workspaces.filter((w) => w.first_analysed_at).length} analysed`,
          },
          {
            label: "Articles",
            value: String(articles.length),
            delta: `${articles.filter((a) => a.status === "review").length} awaiting review`,
          },
          {
            label: "Cost per article",
            value: articles.length ? usd(total / articles.length) : "—",
            delta: articles.length ? "all spend ÷ all articles" : "no articles yet",
          },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll flex flex-col gap-5">
        <Card
          className="shrink-0"
          title="Preview as a customer"
          meta="Your own account, operator bypasses off, writes refused"
          flush
        >
          <PreviewControl active={previewActive} />
        </Card>

        <Card
          className="shrink-0"
          title="Scheduled work"
          meta="What runs, when (UTC), and what it should cost given how the accounts are set up"
          flush
        >
          <ScheduledWork
            forecast={forecast}
            actual30d={actual30d}
            rates={rates}
            measured={measured}
            pendingFirstLooks={drivers.filter((d) => d.needsFirstLook).length}
          />
        </Card>

        <Card className="shrink-0" title="Spend by provider" flush>
          <Table
            head={["Provider", "Calls", "USD"]}
            rows={[...byProvider.entries()]
              .sort((a, b) => b[1].usd - a[1].usd)
              .map(([k, v]) => [k, String(v.calls), usd(v.usd)])}
          />
        </Card>

        <Card className="shrink-0" title="Spend by operation" flush>
          <Table
            head={["Operation", "Calls", "USD", "Avg"]}
            rows={[...byOperation.entries()]
              .sort((a, b) => b[1].usd - a[1].usd)
              .map(([k, v]) => [k, String(v.calls), usd(v.usd), usd(v.usd / v.calls)])}
          />
        </Card>

        <Card className="shrink-0" title="Accounts" flush>
          <Table
            head={["Domain", "Status", "Platform", "Analysed", "Auto", "Tracked", "Articles", "Spend", "Expected / mo"]}
            rows={workspaces.map((w) => [
              w.domain ?? "—",
              w.status ?? "—",
              w.detected_platform ?? "—",
              w.first_analysed_at ? "yes" : "no",
              w.auto_generate ? "on" : "off",
              String(trackedByWs.get(w.id)?.size ?? 0),
              String(articleCount.get(w.id) ?? 0),
              byWorkspace.has(w.id) ? usd(byWorkspace.get(w.id)!) : "—",
              (expectedByWs.get(w.id) ?? 0) > 0 ? `$${expectedByWs.get(w.id)!.toFixed(2)}` : "—",
            ])}
          />
        </Card>

        <Card className="shrink-0" title="Recent calls" flush>
          <Table
            head={["When", "Provider", "Operation", "Workspace", "USD"]}
            rows={(recentCalls ?? []).map((r) => [
              new Date(r.created_at).toLocaleString(),
              r.provider,
              r.operation,
              r.workspace_id ? (wsById.get(r.workspace_id)?.domain ?? "—") : "—",
              // A provider that reported no cost is not a free call.
              r.cost_usd === null ? "—" : usd(Number(r.cost_usd)),
            ])}
          />
        </Card>
      </div>
    </>
  );
}
