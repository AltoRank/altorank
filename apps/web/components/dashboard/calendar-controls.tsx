"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { IconButton } from "@/components/ui/button";
import { Chip, Icons } from "@/components/ui";

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

  const view = searchParams.get("view") ?? "calendar";
  const clientFilter = searchParams.get("clients") ?? "all";

  function setView(v: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", v);
    router.push(`/content?${params.toString()}`);
  }

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
      <div className="flex gap-0.5 p-0.5 bg-panel-2 rounded-[7px]">
        <button
          onClick={() => setView("calendar")}
          className={`px-2.5 py-[5px] text-xs rounded-[5px] font-medium ${
            view === "calendar" ? "bg-bg" : "text-ink-2"
          }`}
        >
          Calendar
        </button>
        <button
          className="px-2.5 py-[5px] text-xs rounded-[5px] text-ink-3 cursor-not-allowed opacity-40"
          title="Coming soon"
          disabled
        >
          Timeline
        </button>
        <button
          className="px-2.5 py-[5px] text-xs rounded-[5px] text-ink-3 cursor-not-allowed opacity-40"
          title="Coming soon"
          disabled
        >
          List
        </button>
      </div>
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
      <Chip
        label="All clients"
        active={clientFilter === "all"}
        onClick={() => setClientFilter("all")}
      />
      <Chip
        label="Publishing"
        active={clientFilter === "publishing"}
        onClick={() => setClientFilter("publishing")}
      />
    </div>
  );
}
