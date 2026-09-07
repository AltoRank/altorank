import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getCalendarEntries } from "@/lib/queries/calendar";
import { getPlannerKeywords, type PlannerKeyword } from "@/lib/queries/keywords";
import { getPlannerArticleStates, getDraftsInFlight, inFlightFor } from "@/lib/queries/planner-state";
import { getPlannerImprovements } from "@/lib/queries/improvements";
import { buildMonthCells } from "@/lib/plan/day-groups";
import { describeSlots, getPlanCapacity } from "@/lib/plan/capacity";
import { deriveFrozen, readUnwrittenEntries } from "@/lib/plan/frozen";
import { quotaExceededMessage } from "@/lib/billing/quota";
import { getRequestQuota } from "@/lib/queries/quota";
import { PageHead, DotSep, StatusPill } from "@/components/ui";
import { Card } from "@/components/ui/card";
import { CalendarControls } from "@/components/dashboard/calendar-controls";
import { PlannerGrid, type PlannerCell, type PlannerItem } from "@/components/dashboard/planner-grid";
import { PlanningProvider } from "@/components/dashboard/planning-state";
import { PlannerSlot } from "@/components/dashboard/planner-slot";
import type { WriteGate } from "@/components/dashboard/planner-card";
import { PlanMonthButton } from "@/components/dashboard/plan-month-button";
import Link from "next/link";
import { Button } from "@/components/ui";
import { HowItWorks } from "@/components/dashboard/how-it-works";
import { contentPlanExplainer } from "@/lib/explainers";
import type { Workspace } from "@/lib/types";
import { plural } from "@/lib/utils";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";

export const metadata: Metadata = { title: "Content planner" };

type Props = {
  searchParams: Promise<{ month?: string }>;
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

  // Two waves of reads, not five. Everything that needs only the scope goes
  // out at once; everything that needs those results goes out together after.
  // Each extra wave is a full round trip to the database on the render's
  // critical path, and this page (with the layout around it) had enough of
  // them in a row to take seconds on a calendar of three entries.
  const supabase = await createClient();
  const [workspaces, entries, capacity, drafts, improvements, unwritten, { data: auth }, { count: keywordCount }] = await Promise.all([
    getWorkspaces(),
    getCalendarEntries(scopeId ?? undefined, month),
    // The same numbers the Articles-plan control quotes: slots held by planned
    // keywords and by scheduled improvements, against the cap.
    scopeId ? getPlanCapacity(supabase, scopeId) : Promise.resolve(null),
    scopeId ? getDraftsInFlight(scopeId) : Promise.resolve([]),
    // Rewrites scheduled this month. They sit on their day like an article
    // and spend one of the week's slots, so the trade-off is on the calendar.
    scopeId ? getPlannerImprovements(scopeId, month) : Promise.resolve([]),
    // The whole unwritten plan, for the frozen boundary below; the quota it
    // needs arrives in the second wave.
    scopeId ? readUnwrittenEntries(supabase, scopeId) : Promise.resolve([]),
    supabase.auth.getUser(),
    // Whether there is anything to plan *from*. An empty month has two causes
    // and they need different offers: a site with keywords needs the plan run,
    // a site with none needs research first, and "Plan the month" on the second
    // schedules nothing and says so only after the click. The dashboard strip
    // was fixed for exactly this; the calendar is where the button lives.
    scopeId
      ? supabase.from("keywords").select("id", { count: "exact", head: true }).eq("workspace_id", scopeId)
      : Promise.resolve({ count: 0 }),
  ]);

  const wsMap = new Map<string, Workspace>(workspaces.map((w) => [w.id, w]));
  const scopedWs = scopeId ? wsMap.get(scopeId) : undefined;

  // The keyword objects behind the squares (shape, volume, difficulty, brief),
  // the articles they became (status, live URL), and the quota that decides
  // whether "Write now" may run. The quota is the same one the sidebar shows,
  // computed once per request (lib/queries/quota.ts).
  const [keywordRows, articleStates, quota] = scopeId
    ? await Promise.all([
        getPlannerKeywords(scopeId, entries.map((e) => e.keyword_id).filter((id): id is string => Boolean(id))),
        getPlannerArticleStates(scopeId, entries.map((e) => e.article_id).filter((id): id is string => Boolean(id))),
        scopedWs ? getRequestQuota(scopedWs.agency_id, auth.user?.email ?? null) : Promise.resolve(null),
      ])
    : [[], new Map(), null];
  const kwById = new Map<string, PlannerKeyword>(keywordRows.map((k) => [k.id, k]));

  // Whether "Write now" can run at all. Only the free draft's exhaustion is a
  // refusal; a paid plan at its limit writes as overage, like any generation.
  let writeGate: WriteGate = { ok: true };
  if (quota && quota.reason === "no-plan" && quota.limit !== null && (quota.remaining ?? 0) <= 0) {
    writeGate = { ok: false, reason: quotaExceededMessage(quota) };
  }

  // Planned keywords beyond what the plan still includes this month, in
  // scheduled order. Derived, never stored: an upgrade or a new month thaws
  // them with no write. Unmetered accounts have nothing frozen.
  const frozen = deriveFrozen(unwritten, quota);

  // A draft being written for a planned keyword shows on the planned day, as
  // "writing". The same article also arrives from `getCalendarEntries` as a
  // derived "run" entry on today's square - the link between the two is only
  // written when the run succeeds - so that copy is dropped here.
  const claimed = new Set<string>();
  const withFlight = entries.map((entry) => {
    const inFlight = entry.article_id ? null : inFlightFor(drafts, entry);
    if (inFlight) claimed.add(inFlight.articleId);
    return { entry, inFlight };
  });
  const articleItems: PlannerItem[] = withFlight
    .filter(({ entry }) => entry.planned || !entry.article_id || !claimed.has(entry.article_id))
    .map(({ entry, inFlight }) => {
      const w = wsMap.get(entry.workspace_id);
      return {
        entry,
        keyword: entry.keyword_id ? kwById.get(entry.keyword_id) ?? null : null,
        // The calendar is one site's calendar - there is no "all sites"
        // scope any more - and the header already names the domain. Stamping
        // it on every square spent the top line of each one, truncated
        // ("acme-ux.altorank.t..."), on the answer to a question the page
        // does not raise. Passed only if a merged view ever comes back.
        workspace: scopeId || !w ? null : { initials: w.initials, color: w.color, domain: w.domain },
        article: entry.article_id ? articleStates.get(entry.article_id) ?? null : null,
        inFlight: inFlight ? { createdAt: inFlight.createdAt, phase: inFlight.phase } : null,
        frozen: frozen.ids.has(entry.id) ? frozen.reason : null,
        improvement: null,
      };
    });
  // An improvement's square stands in for a calendar entry: the task's id and
  // date, the page's title where the keyword goes. The state machine reads
  // the task, not these fields (lib/plan/card-state.ts).
  const improvementItems: PlannerItem[] = improvements.map((imp) => {
    const w = wsMap.get(imp.workspaceId);
    return {
      entry: {
        id: imp.taskId,
        workspace_id: imp.workspaceId,
        article_id: null,
        keyword_id: null,
        keyword: imp.title,
        scheduled_date: imp.scheduledFor,
        status: imp.status === "running" ? "run" : imp.status === "done" ? "done" : "queue",
        created_at: imp.createdAt,
        planned: false,
      },
      keyword: null,
      workspace: scopeId || !w ? null : { initials: w.initials, color: w.color, domain: w.domain },
      article: null,
      inFlight: null,
      frozen: null,
      improvement: imp,
    };
  });
  const items = [...articleItems, ...improvementItems];
  const cells: PlannerCell[] = buildMonthCells(items, yearNum, monthNum, (it) => it.entry.scheduled_date);

  const runningCount = items.filter((it) => it.entry.status === "run" || it.inFlight !== null).length;
  const frozenCount = articleItems.filter((it) => it.frozen !== null).length;
  const slots = capacity?.available ?? 0;
  // Nothing on any day of the month being looked at, and nothing anywhere on
  // the plan: the first-run state, as opposed to a month that is simply past
  // or still ahead of the 30-day horizon.
  const monthIsEmpty = items.length === 0 && (capacity?.scheduled ?? 0) === 0;
  const nothingToPlanFrom = (keywordCount ?? 0) === 0;

  return (
    <PlanningProvider>
        <PageHead
          title={`${monthLabel} plan`}
          subtitle={
            <>
              {runningCount > 0 && <StatusPill status="run" label={`${runningCount} running now`} />}
              <span>{describeSlots(articleItems.length, improvementItems.length)} this month</span>
              {wsMap.get(scopeId ?? "")?.domain ? (
                <>
                  <DotSep />
                  <span className="font-mono text-[11.5px]">{wsMap.get(scopeId ?? "")?.domain}</span>
                </>
              ) : null}
              {/* "N published · N queued" was a breakdown of the count two
                  segments to the left, and every one of those states is a
                  labelled pill on the day it sits on. Four segments plus the
                  capacity line pushed the month out of the title, which is
                  the one thing on this row nothing else repeats. Inactive
                  stays: nothing else on the page says a day was skipped. */}
              {frozenCount > 0 && (
                <>
                  <DotSep />
                  <span title={frozen.reason ?? undefined}>{frozenCount} inactive</span>
                </>
              )}
              {capacity && (
                <>
                  <DotSep />
                  {/* The cap, stated as a count: "N of 60" is a fact about the
                      calendar, and the room left is what the Plan button fills.
                      Both kinds of slot are named when both are held. */}
                  <span>
                    {capacity.scheduled} of {capacity.cap} scheduled
                    {capacity.improvements > 0 && ` (${describeSlots(capacity.articles, capacity.improvements)})`}
                    {" · "}
                    {plural(slots, "slot")} available
                  </span>
                </>
              )}
            </>
          }
          actions={
            <>
              {/* contentPlanExplainer was written for this page and never
                  mounted anywhere, so the one surface whose behaviour is
                  pure arithmetic - which keyword, on which day, why - had no
                  way to say what the arithmetic is. */}
              <HowItWorks explainer={contentPlanExplainer} />
              {scopeId && slots > 0 &&
                (nothingToPlanFrom ? (
                  <Link href="/keywords">
                    <Button size="sm">Research keywords</Button>
                  </Link>
                ) : (
                  <PlanMonthButton label={(capacity?.articles ?? 0) === 0 ? "Plan the month" : "Top up the plan"} />
                ))}
            </>
          }
        />

        <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
          <CalendarControls currentMonth={month} monthLabel={monthLabel} />

          {/* An empty month renders a grid of blank squares: the per-day hint
              is hidden until hover, so the one screen a new site sees most
              said nothing at all about why it was empty or what to do. */}
          {monthIsEmpty && (
            <p className="mb-3 text-[12.5px] leading-[1.6] text-ink-3">
              {nothingToPlanFrom
                ? "Nothing is scheduled this month, and there are no keywords to schedule from yet. Research keywords first; the plan is built from the ones this site can realistically rank for."
                : "Nothing is scheduled this month. Planning fills these days from the keywords this site can realistically rank for, and you can drag any of them to another day afterwards."}
            </p>
          )}

          <Card flush>
            <PlannerSlot
              pace={capacity?.weeklyLimit ?? 0}
              occupied={cells.flatMap((c) => (c ? c.items.map(() => c.date) : []))}
            >
              <PlannerGrid cells={cells} now={now.getTime()} writeGate={writeGate} frozenCount={frozenCount} />
            </PlannerSlot>
          </Card>
        </div>
    </PlanningProvider>
  );
}
