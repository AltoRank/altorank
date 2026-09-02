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
  measuredRates,
  type JobKey,
  type WorkspaceDrivers,
} from "@/lib/billing/forecast";

export const metadata: Metadata = { title: "Operations" };

/**
 * What the machine is costing us, per workspace and per provider.
 *
 * Reads across every account, so it is gated on an operator email rather than
 * on agency membership, and it uses the service client deliberately: the whole
 * point is the numbers RLS would hide.
 *
 * Every figure here is what a provider reported, never an estimate. A provider
 * that reports no cost shows a dash, because "free" and "did not say" are
 * different facts and averaging them would understate the bill.
 */
export default async function AdminPage() {
  if (!(await isAdmin())) notFound();

  const supabase = createServiceClient();

  const [{ data: spend }, { data: workspaces }, { data: articles }, { data: trackedKw }, { data: prompts }] =
    await Promise.all([
      supabase
        .from("provider_spend")
        .select("provider, operation, cost_usd, workspace_id, article_id, created_at")
        .order("created_at", { ascending: false })
        .limit(2000),
      supabase
        .from("workspaces")
        .select("id, domain, status, detected_platform, first_analysed_at, auto_generate, auto_generate_weekly_limit, geo_tracking"),
      supabase.from("articles").select("workspace_id, status, keyword"),
      // What cron/serp will track: the same status filter it uses.
      supabase.from("keywords").select("workspace_id, term").in("status", ["planned", "shipped"]),
      supabase.from("geo_prompts").select("workspace_id").eq("enabled", true),
    ]);

  // Null whenever the preview is off, and also for a non-operator, though
  // this page 404s for those before we get here.
  const previewActive = (await getOperatorPreview()) !== null;

  const rows = spend ?? [];
  const wsById = new Map((workspaces ?? []).map((w) => [w.id, w]));

  const total = rows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
  const since = rows.length ? rows[rows.length - 1].created_at : null;

  // By provider
  const byProvider = new Map<string, { calls: number; usd: number }>();
  for (const r of rows) {
    const e = byProvider.get(r.provider) ?? { calls: 0, usd: 0 };
    e.calls += 1;
    e.usd += Number(r.cost_usd ?? 0);
    byProvider.set(r.provider, e);
  }

  // By operation, which is where a spike is actually traceable
  const byOperation = new Map<string, { calls: number; usd: number }>();
  for (const r of rows) {
    const key = `${r.provider} · ${r.operation}`;
    const e = byOperation.get(key) ?? { calls: 0, usd: 0 };
    e.calls += 1;
    e.usd += Number(r.cost_usd ?? 0);
    byOperation.set(key, e);
  }

  // By workspace, with article counts, so cost per article is visible
  const articleCount = new Map<string, number>();
  for (const a of articles ?? []) {
    articleCount.set(a.workspace_id, (articleCount.get(a.workspace_id) ?? 0) + 1);
  }
  const byWorkspace = new Map<string, number>();
  for (const r of rows) {
    if (!r.workspace_id) continue;
    byWorkspace.set(r.workspace_id, (byWorkspace.get(r.workspace_id) ?? 0) + Number(r.cost_usd ?? 0));
  }

  const usd = (n: number) => `$${n.toFixed(4)}`;

  // --- What the schedule is expected to cost, from the users' settings -----
  // Mirrors cron/serp's tracking rule: planned + shipped keywords, plus any
  // article keyword not already among them, capped in the forecast.
  const trackedByWs = new Map<string, Set<string>>();
  for (const k of trackedKw ?? []) {
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
  for (const p of prompts ?? []) promptsByWs.set(p.workspace_id, (promptsByWs.get(p.workspace_id) ?? 0) + 1);

  const drivers: WorkspaceDrivers[] = (workspaces ?? []).map((w) => ({
    id: w.id,
    domain: w.domain ?? "—",
    trackedKeywords: trackedByWs.get(w.id)?.size ?? 0,
    autoGenerate: Boolean(w.auto_generate),
    weeklyLimit: (w.auto_generate_weekly_limit as number | null) ?? null,
    geoTracking: Boolean(w.geo_tracking),
    enabledPrompts: promptsByWs.get(w.id) ?? 0,
    needsFirstLook: !w.first_analysed_at,
  }));

  const { rates, measured } = measuredRates(
    rows.map((r) => ({
      provider: r.provider,
      operation: r.operation,
      costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
      articleId: r.article_id,
    })),
  );
  const forecast = forecastAll(drivers, rates);
  const expectedByWs = new Map(forecast.perWorkspace.map((f) => [f.id, f.total]));

  // Async Server Component: one render per request, so the read is stable for
  // the render's lifetime. The rule guards client re-renders, which this
  // page never has.
  // eslint-disable-next-line react-hooks/purity
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const actual30d: Record<JobKey, number> = { serp: 0, backlinks: 0, generate: 0, geo: 0, analyze: 0 };
  for (const r of rows) {
    if (new Date(r.created_at).getTime() < cutoff) continue;
    const job = jobForOperation(r.provider, r.operation);
    if (job) actual30d[job] += Number(r.cost_usd ?? 0);
  }

  return (
    <>
      <PageHead
        title="Operations"
        subtitle={
          <span>
            {rows.length.toLocaleString()} recorded provider calls
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
            value: String((workspaces ?? []).length),
            delta: `${(workspaces ?? []).filter((w) => w.first_analysed_at).length} analysed`,
          },
          {
            label: "Articles",
            value: String((articles ?? []).length),
            delta: `${(articles ?? []).filter((a) => a.status === "review").length} awaiting review`,
          },
          {
            label: "Cost per article",
            value: (articles ?? []).length ? usd(total / (articles ?? []).length) : "—",
            delta: (articles ?? []).length ? "all spend ÷ all articles" : "no articles yet",
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
            rows={(workspaces ?? []).map((w) => [
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
            rows={rows.slice(0, 40).map((r) => [
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
