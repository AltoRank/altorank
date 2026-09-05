import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getCalendarEntries } from "@/lib/queries/calendar";
import { getPlannerKeywords, type PlannerKeyword } from "@/lib/queries/keywords";
import { getPlannerArticleStates, getDraftsInFlight, inFlightFor } from "@/lib/queries/planner-state";
import { countScheduled, PLAN_MAX_ENTRIES } from "@/lib/onboarding/plan";
import { buildMonthCells } from "@/lib/plan/day-groups";
import { getQuota, quotaExceededMessage } from "@/lib/billing/quota";
import { PageHead, DotSep, StatusPill } from "@/components/ui";
import { Card } from "@/components/ui/card";
import { CalendarControls } from "@/components/dashboard/calendar-controls";
import { PlannerGrid, type PlannerCell, type PlannerItem } from "@/components/dashboard/planner-grid";
import type { WriteGate } from "@/components/dashboard/planner-card";
import { PlanMonthButton } from "@/components/dashboard/plan-month-button";
import type { Workspace } from "@/lib/types";
import { plural } from "@/lib/utils";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";

export const metadata: Metadata = { title: "Calendar" };

type Props = {
  searchParams: Promise<{ month?: string; clients?: string }>;
};

export default async function CalendarPage({ searchParams }: Props) {
  // Every section is about one site unless the switcher says otherwise.
  const scopeId = await getScopedWorkspaceId();
  const params = await searchParams;

  const now = new Date();
  const month = params.month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [yearNum, monthNum] = month.split("-").map(Number);
  const monthDate = new Date(yearNum, monthNum - 1, 1);
  const monthLabel = monthDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const supabase = await createClient();
  const [workspaces, entries, scheduled, drafts] = await Promise.all([
    getWorkspaces(),
    getCalendarEntries(scopeId ?? undefined, month),
    scopeId ? countScheduled(supabase, scopeId) : Promise.resolve(0),
    scopeId ? getDraftsInFlight(scopeId) : Promise.resolve([]),
  ]);

  // The keyword objects behind the squares (shape, volume, difficulty, brief)
  // and the articles they became (status, live URL).
  const [keywordRows, articleStates] = scopeId
    ? await Promise.all([
        getPlannerKeywords(scopeId, entries.map((e) => e.keyword_id).filter((id): id is string => Boolean(id))),
        getPlannerArticleStates(scopeId, entries.map((e) => e.article_id).filter((id): id is string => Boolean(id))),
      ])
    : [[], new Map()];
  const kwById = new Map<string, PlannerKeyword>(keywordRows.map((k) => [k.id, k]));

  const wsMap = new Map<string, Workspace>(workspaces.map((w) => [w.id, w]));

  // Whether "Write now" can run at all. Only the free draft's exhaustion is a
  // refusal; a paid plan at its limit writes as overage, like any generation.
  let writeGate: WriteGate = { ok: true };
  const scopedWs = scopeId ? wsMap.get(scopeId) : undefined;
  if (scopedWs) {
    const { data: auth } = await supabase.auth.getUser();
    const quota = await getQuota(supabase, scopedWs.agency_id, auth.user?.email ?? null);
    if (quota.reason === "no-plan" && quota.limit !== null && (quota.remaining ?? 0) <= 0) {
      writeGate = { ok: false, reason: quotaExceededMessage(quota) };
    }
  }

  // Apply client filter
  const clientFilter = params.clients;
  const filteredEntries = clientFilter === "publishing"
    ? entries.filter((e) => {
        const w = wsMap.get(e.workspace_id);
        return w?.status === "on";
      })
    : entries;

  // A draft being written for a planned keyword shows on the planned day, as
  // "writing". The same article also arrives from `getCalendarEntries` as a
  // derived "run" entry on today's square - the link between the two is only
  // written when the run succeeds - so that copy is dropped here.
  const claimed = new Set<string>();
  const withFlight = filteredEntries.map((entry) => {
    const inFlight = entry.article_id ? null : inFlightFor(drafts, entry);
    if (inFlight) claimed.add(inFlight.articleId);
    return { entry, inFlight };
  });
  const items: PlannerItem[] = withFlight
    .filter(({ entry }) => entry.planned || !entry.article_id || !claimed.has(entry.article_id))
    .map(({ entry, inFlight }) => {
      const w = wsMap.get(entry.workspace_id);
      return {
        entry,
        keyword: entry.keyword_id ? kwById.get(entry.keyword_id) ?? null : null,
        workspace: w ? { initials: w.initials, color: w.color, domain: w.domain } : null,
        article: entry.article_id ? articleStates.get(entry.article_id) ?? null : null,
        inFlight: inFlight ? { createdAt: inFlight.createdAt, phase: inFlight.phase } : null,
      };
    });
  const cells: PlannerCell[] = buildMonthCells(items, yearNum, monthNum, (it) => it.entry.scheduled_date);

  const doneCount = items.filter((it) => it.entry.status === "done").length;
  const runningCount = items.filter((it) => it.entry.status === "run" || it.inFlight !== null).length;
  const queuedCount = items.filter((it) => it.entry.status === "queue").length;
  const slots = Math.max(0, PLAN_MAX_ENTRIES - scheduled);

  return (
    <>
      <PageHead
        title={`${monthLabel} plan`}
        subtitle={
          <>
            {runningCount > 0 && <StatusPill status="run" label={`${runningCount} running now`} />}
            <span>{plural(items.length, "article")} this month</span>
            <DotSep />
            <span>{doneCount} published · {queuedCount} queued</span>
            {scopeId && (
              <>
                <DotSep />
                {/* The cap, stated as a count: "N of 60" is a fact about the
                    calendar, and the room left is what the Plan button fills. */}
                <span>{scheduled} of {PLAN_MAX_ENTRIES} scheduled · {plural(slots, "slot")} available</span>
              </>
            )}
          </>
        }
        actions={<>{scopeId && slots > 0 && <PlanMonthButton label={scheduled === 0 ? "Plan the month" : "Top up the plan"} />}</>}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <CalendarControls currentMonth={month} monthLabel={monthLabel} />

        <Card flush>
          <PlannerGrid cells={cells} now={now.getTime()} writeGate={writeGate} />
        </Card>
      </div>
    </>
  );
}
