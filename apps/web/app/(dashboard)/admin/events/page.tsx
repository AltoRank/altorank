import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHead, Card, StatStrip, Chip } from "@/components/ui";
import { createServiceClient } from "@/lib/supabase/server";
import { getOperator } from "@/lib/auth/admin";
import { plural } from "@/lib/utils";
import { AdminTabs } from "../admin-tabs";
import { Table } from "../table";

export const metadata: Metadata = { title: "Events" };

/**
 * What broke, across every account.
 *
 * Until this page existed, the answer lived in three places that all needed
 * somebody to already be looking: a Vercel function log, a JSON body returned
 * to a scheduler that reads nothing, and a status column on one row. On
 * 2026-09-07 a real customer's onboarding stalled and the only way that was
 * found was a hand-written query against the production database.
 *
 * Read across every tenant, so — exactly like the costs and users panes — it
 * is gated on an operator email (`getOperator`, which is also null while an
 * operator is viewing as a customer) and reads through the service client.
 * `system_events` has RLS on with no policies, so the service client is the
 * only thing that can read it at all.
 *
 * Nothing here is inferred. A row says what a call site wrote; a filter that
 * matches nothing says the filter matched nothing, and an empty table says the
 * product has recorded nothing rather than that nothing has gone wrong.
 */

/** Levels, in the order an operator wants them. */
const LEVELS = ["error", "warn", "info"] as const;
type Level = (typeof LEVELS)[number];

type EventRow = {
  id: string;
  created_at: string;
  level: Level;
  source: string;
  message: string;
  agency_id: string | null;
  workspace_id: string | null;
  context: Record<string, unknown> | null;
};

/** How many rows one page shows. Enough for a morning, short of a scroll trap. */
const PAGE_SIZE = 200;
/** The window the counters describe, and the only claim they make. */
const WINDOW_HOURS = 24;

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

function isLevel(value: string | undefined): value is Level {
  return value === "error" || value === "warn" || value === "info";
}

/** The link that toggles one filter without losing the other. */
function href(params: { level?: string; source?: string }): string {
  const q = new URLSearchParams();
  if (params.level) q.set("level", params.level);
  if (params.source) q.set("source", params.source);
  const query = q.toString();
  return query ? `/admin/events?${query}` : "/admin/events";
}

/** The context object as one line, with the noisiest keys first. */
function contextLine(context: Record<string, unknown> | null): string {
  if (!context) return "";
  const entries = Object.entries(context).filter(([, v]) => v !== null && v !== "" && v !== undefined);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("  ");
}

export default async function AdminEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ level?: string; source?: string }>;
}) {
  const operator = await getOperator();
  if (!operator) notFound();

  const { level: levelParam, source: sourceParam } = await searchParams;
  const level = isLevel(levelParam) ? levelParam : null;
  const source = sourceParam?.trim() || null;

  const admin = createServiceClient();

  let query = admin
    .from("system_events")
    .select("id, created_at, level, source, message, agency_id, workspace_id, context")
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);
  if (level) query = query.eq("level", level);
  if (source) query = query.eq("source", source);

  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const [{ data, error }, { data: recent }, { data: sources }, { data: workspaces }] = await Promise.all([
    query,
    // The counters describe the window, not the page: a filtered page must not
    // change what "12 errors today" means.
    admin.from("system_events").select("level").gte("created_at", since),
    // Every source that has ever written, for the filter row. Distinct is not
    // available through PostgREST, so this is the last 1000 and is honest
    // about being that: a source silent for longer simply is not offered.
    admin.from("system_events").select("source").order("created_at", { ascending: false }).limit(1000),
    admin.from("workspaces").select("id, domain"),
  ]);

  const rows = (data ?? []) as EventRow[];
  const domainOf = new Map((workspaces ?? []).map((w) => [w.id as string, (w.domain as string | null) ?? null]));

  const counts: Record<Level, number> = { error: 0, warn: 0, info: 0 };
  for (const r of recent ?? []) {
    const l = r.level as Level;
    if (l in counts) counts[l] += 1;
  }

  const knownSources = [...new Set((sources ?? []).map((s) => s.source as string))].sort();

  // A table that has never been written to and a query that failed are
  // different facts, and the difference is the whole point of this page.
  const unavailable = error
    ? `The log could not be read: ${error.message}. If migration 082 has not been applied to this database, that is why.`
    : null;

  return (
    <>
      <PageHead
        title="Operations"
        subtitle={
          <span>
            {unavailable
              ? "The event log is unavailable"
              : `${plural(rows.length, "event")} shown · newest first`}
          </span>
        }
      />

      <AdminTabs />

      <StatStrip
        stats={[
          {
            label: `Errors · ${WINDOW_HOURS}h`,
            value: unavailable ? "—" : String(counts.error),
            delta: "something did not happen",
          },
          {
            label: `Warnings · ${WINDOW_HOURS}h`,
            value: unavailable ? "—" : String(counts.warn),
            delta: "finished short of what was asked",
          },
          {
            label: `Notices · ${WINDOW_HOURS}h`,
            value: unavailable ? "—" : String(counts.info),
            delta: "ran clean; proof the schedule fired",
          },
          {
            label: "Sources",
            value: unavailable ? "—" : String(knownSources.length),
            delta: "seen in the last 1000 events",
          },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll flex flex-col gap-5">
        <Card
          className="shrink-0"
          title="System events"
          meta="Written by lib/observability/record.ts from the failure paths that used to end in a console line. Operator-only; never shown to a customer."
          flush
        >
          <div className="flex flex-wrap items-center gap-1.5 px-3.5 py-3 border-b border-line-soft">
            <Link
              href={href({ source: source ?? undefined })}
              className={`rounded-full px-2.5 py-1 text-[12px] ${level === null ? "bg-ink text-bg" : "text-ink-3 hover:text-ink"}`}
            >
              All levels
            </Link>
            {LEVELS.map((l) => (
              <Link
                key={l}
                href={href({ level: l, source: source ?? undefined })}
                className={`rounded-full px-2.5 py-1 text-[12px] ${level === l ? "bg-ink text-bg" : "text-ink-3 hover:text-ink"}`}
              >
                {l}
              </Link>
            ))}
            <span className="mx-2 h-4 w-px bg-line" aria-hidden />
            <Link
              href={href({ level: level ?? undefined })}
              className={`rounded-full px-2.5 py-1 text-[12px] ${source === null ? "bg-ink text-bg" : "text-ink-3 hover:text-ink"}`}
            >
              All sources
            </Link>
            {knownSources.map((s) => (
              <Link
                key={s}
                href={href({ level: level ?? undefined, source: s })}
                className={`rounded-full px-2.5 py-1 font-mono text-[11.5px] ${source === s ? "bg-ink text-bg" : "text-ink-3 hover:text-ink"}`}
              >
                {s}
              </Link>
            ))}
          </div>

          {unavailable ? (
            <p className="px-3.5 py-8 text-center text-[13px] text-ink-3">{unavailable}</p>
          ) : (
            <Table
              head={["When", "Level", "Source", "What happened", "Site"]}
              empty={
                level || source
                  ? "No event matches that filter. That is the filter, not the product: clear it to see everything recorded."
                  : "Nothing has been recorded yet. Either nothing has failed since this shipped, or nothing has run — the notices above say which."
              }
              rows={rows.map((r) => [
                <span key="when" className="font-mono text-[12px] text-ink-3">
                  {when(r.created_at)}
                </span>,
                <Chip key="level" label={r.level} soft />,
                <span key="source" className="font-mono text-[12px]">
                  {r.source}
                </span>,
                <span key="what" className="flex flex-col gap-0.5 font-sans">
                  <span className="text-[13px] text-ink">{r.message}</span>
                  {contextLine(r.context) && (
                    <span className="font-mono text-[11.5px] text-ink-3 break-all">{contextLine(r.context)}</span>
                  )}
                </span>,
                <span key="site" className="font-sans text-[13px]">
                  {r.workspace_id ? (
                    domainOf.get(r.workspace_id) ?? <span className="text-ink-3">deleted site</span>
                  ) : (
                    // Not "none" and not a blank: a run-wide failure genuinely
                    // was not about one site, and saying so is the honest cell.
                    <span className="text-ink-3" title="This failure was not about one site">
                      —
                    </span>
                  )}
                </span>,
              ])}
            />
          )}
        </Card>
      </div>
    </>
  );
}
