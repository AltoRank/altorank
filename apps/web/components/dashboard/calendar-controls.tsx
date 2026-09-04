"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { IconButton } from "@/components/ui/button";
import { Chip, Icons } from "@/components/ui";
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

  const clientFilter = searchParams.get("clients") ?? "all";


  function setClientFilter(v: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (v === "all") {
      params.delete("clients");
    } else {
      params.set("clients", v);
    }
    router.push(`/content?${params.toString()}`);
  }

  return (
    <>
    {active?.status === "paused" && (
      <PausedBanner workspaceId={active.id} meta={active.paused_meta} className="mb-4" />
    )}
    <div className="flex items-center gap-2 mb-4 flex-wrap">
      <div className="flex items-center gap-2 ml-2">
        <IconButton ghost onClick={() => navigateMonth(-1)}>
          <Icons.arrowLeft size={14} />
        </IconButton>
        <span className="font-medium text-sm">{monthLabel}</span>
        <IconButton ghost onClick={() => navigateMonth(1)}>
          <Icons.arrow size={14} />
        </IconButton>
      </div>
      <div className="flex-1" />
      <ArticlesPlanPopover />
      <Chip
        label="All workspaces"
        active={clientFilter === "all"}
        onClick={() => setClientFilter("all")}
      />
      <Chip
        label="Publishing"
        active={clientFilter === "publishing"}
        onClick={() => setClientFilter("publishing")}
      />
    </div>
    </>
  );
}
