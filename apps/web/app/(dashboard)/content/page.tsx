import type { Metadata } from "next";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getCalendarEntries } from "@/lib/queries/calendar";
import { PageHead, DotSep, StatusPill, Avatar, Icons, Button } from "@/components/ui";
import { Card } from "@/components/ui/card";
import { CalendarControls } from "@/components/dashboard/calendar-controls";
import type { Workspace } from "@/lib/types";
import { plural } from "@/lib/utils";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";

export const metadata: Metadata = { title: "Calendar" };

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const stLabel: Record<string, string> = { done: "Published", run: "Drafting", scheduled: "Scheduled", queue: "Queued" };

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

  const [workspaces, entries] = await Promise.all([
    getWorkspaces(),
    getCalendarEntries(scopeId ?? undefined, month),
  ]);

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

  return (
    <>
      <PageHead
        title={`${monthLabel} plan`}
        subtitle={<>{runningCount > 0 && <StatusPill status="run" label={`${runningCount} running now`} />}<span>{plural(filteredEntries.length, "article")} · {plural(workspaces.length, "workspace")}</span><DotSep /><span>{doneCount} published · {queuedCount} queued</span></>}
        actions={
          <>
          </>
        }
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
              const item = dayItems[0];
              const w = item ? wsMap.get(item.workspace_id) : null;

              return (
                <div
                  key={i}
                  className={`min-h-[130px] p-2 px-2.5 border-r border-line-soft border-b border-b-line-soft [&:nth-child(7n)]:border-r-0 ${
                    item?.status === "run" ? "bg-accent-soft" : !isValidDay ? "bg-[oklch(0.99_0_0)]" : ""
                  }`}
                >
                  {isValidDay && (
                    <>
                      <div className={`font-mono text-[11px] mb-1.5 ${item?.status === "run" ? "text-accent-ink font-semibold" : "text-ink-3"}`}>
                        {dayNum}
                      </div>
                      {item && w && (
                        <div className="text-xs">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <Avatar initials={w.initials} color={w.color} size="sm" className="w-4 h-4 text-[8px] rounded" />
                            <span className="font-mono text-[10px] text-ink-3">{w.domain}</span>
                          </div>
                          <div className="text-xs text-ink leading-[1.35] line-clamp-2">{item.keyword}</div>
                          <div className="mt-1.5">
                            <StatusPill status={item.status} label={stLabel[item.status]} />
                          </div>
                        </div>
                      )}
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
