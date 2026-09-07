"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { IconButton } from "@/components/ui/button";
import { Icons } from "@/components/ui";
import { ResearchButtons } from "@/components/dashboard/keyword-research/research-buttons";
import { ArticlesPlanPopover } from "@/components/dashboard/articles-plan-popover";
import { PausedBanner } from "@/components/dashboard/paused-banner";
import { useWorkspace } from "@/components/dashboard/workspace-context";

interface CalendarControlsProps {
  currentMonth: string; // "2026-05"
  monthLabel: string;   // "May 2026"
}

export function CalendarControls({ currentMonth, monthLabel }: CalendarControlsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { active } = useWorkspace();

  function navigateMonth(delta: number) {
    const [y, m] = currentMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    const newMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const params = new URLSearchParams(searchParams.toString());
    params.set("month", newMonth);
    router.push(`/content?${params.toString()}`);
  }

  return (
    <>
    {active?.status === "paused" && (
      <PausedBanner workspaceId={active.id} meta={active.paused_meta} className="mb-4" />
    )}
    <div className="flex items-center gap-2 mb-4 flex-wrap">
      <div className="flex items-center gap-2 ml-2">
        <IconButton ghost aria-label="Previous month" onClick={() => navigateMonth(-1)}>
          <Icons.arrowLeft size={14} />
        </IconButton>
        <span className="font-medium text-sm">{monthLabel}</span>
        <IconButton ghost aria-label="Next month" onClick={() => navigateMonth(1)}>
          <Icons.arrow size={14} />
        </IconButton>
      </div>
      <div className="flex-1" />
      {/* Two groups, not one row of four. On the left of the divider, the
          setting that governs the calendar itself; on the right, the two ways
          to get keywords into it. They were adjacent and identically weighted,
          which is how a pace setting came to look like a sibling of a research
          action. All of them are `sm` and unaccented: the primary action on
          this page is the schedule button in the header, and it is the only
          accent on the screen. */}
      <ArticlesPlanPopover />
      <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-line" />
      {/* An "All / Publishing" pair used to sit here. It was left over from
          the all-sites calendar: it filtered entries by their *workspace's*
          status, and the calendar has been one site's since the merged scope
          was removed, so "Publishing" could only ever show the whole month or
          an empty grid depending on whether that one site was paused. The
          comment beside it claimed it filtered entry kind, which it never
          did. A control with two settings and one outcome is worse than no
          control. */}
      <ResearchButtons size="sm" emphasis="secondary" />
    </div>
    </>
  );
}
