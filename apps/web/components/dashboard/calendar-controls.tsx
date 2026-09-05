"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { IconButton } from "@/components/ui/button";
import { Chip, Icons } from "@/components/ui";
import { ResearchButtons } from "@/components/dashboard/keyword-research/research-buttons";

interface CalendarControlsProps {
  currentMonth: string; // "2026-05"
  monthLabel: string;   // "May 2026"
}

export function CalendarControls({ currentMonth, monthLabel }: CalendarControlsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

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
      {/* Was "All workspaces", which named the wrong axis: the calendar is
          scoped to one site, and this chip filters entry kind, not workspace. */}
      <Chip
        label="All"
        active={clientFilter === "all"}
        onClick={() => setClientFilter("all")}
      />
      <Chip
        label="Publishing"
        active={clientFilter === "publishing"}
        onClick={() => setClientFilter("publishing")}
      />
      <ResearchButtons />
    </div>
  );
}
