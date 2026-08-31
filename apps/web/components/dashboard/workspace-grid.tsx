"use client";

import { useState } from "react";
import Link from "next/link";
import { Avatar, StatusPill, Chip } from "@/components/ui";
import type { Workspace } from "@/lib/types";

const STATUS_LABEL_MAP: Record<string, string> = {
  on: "Publishing",
  review: "Review",
  paused: "Paused",
  setup: "Setup",
};

const FILTERS = [
  { label: "All", status: null },
  { label: "Publishing", status: "on" },
  { label: "Review", status: "review" },
  { label: "Paused", status: "paused" },
] as const;

type WorkspaceGridProps = {
  workspaces: Workspace[];
  counts: Record<string, { total: number; live: number }>;
};

export function WorkspaceGrid({ workspaces, counts }: WorkspaceGridProps) {
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  const filtered = activeFilter
    ? workspaces.filter((w) => w.status === activeFilter)
    : workspaces;

  return (
    <>
      <div className="px-[18px] py-2.5 border-b border-line-soft flex items-center gap-2">
        {FILTERS.map((f) => (
          <Chip
            key={f.label}
            label={f.label}
            active={activeFilter === f.status}
            onClick={() => setActiveFilter(f.status)}
          />
        ))}
      </div>
      <div className="p-3.5 grid grid-cols-4 gap-3">
        {filtered.map((w) => {
          const c = counts[w.id] ?? { total: 0, live: 0 };
          return (
            <Link
              key={w.id}
              href={`/workspaces/${w.id}`}
              className="text-left p-3.5 border border-line rounded-[10px] bg-bg hover:bg-panel hover:border-[oklch(0.88_0.004_80)]"
            >
              <div className="flex items-center gap-2.5 mb-3.5">
                <Avatar initials={w.initials} color={w.color} size="lg" />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-[13.5px]">{w.name}</div>
                  <div className="font-mono text-[11px] text-ink-3 mt-px">{w.domain}</div>
                </div>
                <StatusPill status={w.status} label={STATUS_LABEL_MAP[w.status]} />
              </div>
              <div className="grid grid-cols-2 gap-x-3.5 gap-y-2.5">
                {[
                  { v: String(c.total), l: "Articles" },
                  { v: w.traffic?.toLocaleString() ?? "—", l: "Traffic" },
                  { v: typeof w.dr === "number" ? String(w.dr) : "—", l: "Authority" },
                ].map((s) => (
                  <div key={s.l} className="flex flex-col">
                    <span className="font-mono text-[13px] font-semibold text-ink">{s.v}</span>
                    <span className="text-[10.5px] text-ink-3 uppercase tracking-[0.06em] font-mono mt-px">{s.l}</span>
                  </div>
                ))}
              </div>
            </Link>
          );
        })}
        {filtered.length === 0 && (
          <div className="col-span-4 py-8 text-center text-ink-3 text-[13px]">
            No workspaces match this filter
          </div>
        )}
      </div>
    </>
  );
}
