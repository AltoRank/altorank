import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getCalendarEntries } from "@/lib/queries/calendar";
import { getPlannerKeywords, type PlannerKeyword } from "@/lib/queries/keywords";
import { countScheduled, PLAN_MAX_ENTRIES } from "@/lib/onboarding/plan";
import { PageHead, DotSep, StatusPill } from "@/components/ui";
import { Card } from "@/components/ui/card";
import { CalendarControls } from "@/components/dashboard/calendar-controls";
import { PlannerCard } from "@/components/dashboard/planner-card";
import { PlanMonthButton } from "@/components/dashboard/plan-month-button";
import type { Workspace } from "@/lib/types";
import { plural } from "@/lib/utils";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";

export const metadata: Metadata = { title: "Calendar" };

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Cards shown per square before the rest collapse into "+N more". */
const PER_DAY = 3;

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
  const [workspaces, entries, scheduled] = await Promise.all([
    getWorkspaces(),
    getCalendarEntries(scopeId ?? undefined, month),
    scopeId ? countScheduled(supabase, scopeId) : Promise.resolve(0),
  ]);

  // The keyword objects behind the squares: shape, volume, difficulty, brief.
  const keywordRows = scopeId
    ? await getPlannerKeywords(scopeId, entries.map((e) => e.keyword_id).filter((id): id is string => Boolean(id)))
    : [];
  const kwById = new Map<string, PlannerKeyword>(keywordRows.map((k) => [k.id, k]));

  const wsMap = new Map<string, Workspace>(workspaces.map((w) => [w.id, w]));

  // Apply client filter
  const clientFilter = params.clients;
  const filteredEntries = clientFilter === "publishing"
    ? entries.filter((e) => {
        const w = wsMap.get(e.workspace_id);
        return w?.status === "on";
      })
    : entries;

  // Build calendar grid
  const daysInMonth = new Date(yearNum, monthNum, 0).getDate();
  const firstDayOfWeek = (new Date(yearNum, monthNum - 1, 1).getDay() + 6) % 7;
  const totalCells = Math.ceil((daysInMonth + firstDayOfWeek) / 7) * 7;

  const dayEntries = new Map<number, typeof filteredEntries>();
  for (const e of filteredEntries) {
    const day = new Date(e.scheduled_date).getDate();
    const arr = dayEntries.get(day) ?? [];
    arr.push(e);
    dayEntries.set(day, arr);
  }

  const doneCount = filteredEntries.filter((e) => e.status === "done").length;
  const runningCount = filteredEntries.filter((e) => e.status === "run").length;
  const queuedCount = filteredEntries.filter((e) => e.status === "queue").length;
  const slots = Math.max(0, PLAN_MAX_ENTRIES - scheduled);

  return (
    <>
      <PageHead
        title={`${monthLabel} plan`}
        subtitle={
          <>
            {runningCount > 0 && <StatusPill status="run" label={`${runningCount} running now`} />}
            <span>{plural(filteredEntries.length, "article")} this month</span>
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
          {/* Day headers */}
          <div className="grid grid-cols-7 bg-panel border-b border-line">
            {DAY_NAMES.map((d) => (
              <div key={d} className="px-3.5 py-2.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3 border-r border-line last:border-r-0">
                {d}
              </div>
            ))}
          </div>
          {/* Calendar grid */}
          <div className="grid grid-cols-7">
            {Array.from({ length: totalCells }).map((_, i) => {
              const dayNum = i - firstDayOfWeek + 1;
              const isValidDay = dayNum >= 1 && dayNum <= daysInMonth;
              const dayItems = isValidDay ? dayEntries.get(dayNum) ?? [] : [];
              const running = dayItems.some((e) => e.status === "run");
              const shown = dayItems.slice(0, PER_DAY);

              return (
                <div
                  key={i}
                  className={`min-h-[130px] p-2 px-2.5 border-r border-line-soft border-b border-b-line-soft [&:nth-child(7n)]:border-r-0 ${
                    running ? "bg-accent-soft" : !isValidDay ? "bg-[oklch(0.99_0_0)]" : ""
                  }`}
                >
                  {isValidDay && (
                    <>
                      <div className={`font-mono text-[11px] mb-1.5 ${running ? "text-accent-ink font-semibold" : "text-ink-3"}`}>
                        {dayNum}
                      </div>
                      <div className="space-y-2.5">
                        {shown.map((item) => {
                          const w = wsMap.get(item.workspace_id);
                          return (
                            <PlannerCard
                              key={item.id}
                              entry={item}
                              keyword={item.keyword_id ? kwById.get(item.keyword_id) ?? null : null}
                              workspace={w ? { initials: w.initials, color: w.color, domain: w.domain } : null}
                            />
                          );
                        })}
                        {dayItems.length > PER_DAY && (
                          <div className="font-mono text-[10px] text-ink-3">+{dayItems.length - PER_DAY} more</div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </>
  );
}
