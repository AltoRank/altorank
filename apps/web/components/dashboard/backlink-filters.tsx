"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Chip, SearchInput } from "@/components/ui";

const TAB_CHIPS = [
  { label: "Active links", value: "live" },
  { label: "Pending", value: "pending" },
  { label: "Negotiating", value: "negotiating" },
  { label: "Lost links", value: "lost" },
  { label: "All", value: "" },
];

export function BacklinkFilters({ workspaces = [] }: { workspaces?: { id: string; name: string }[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentStatus = searchParams.get("status") ?? "";

  const currentWorkspace = searchParams.get("workspace") ?? "";

  // The page read only `status`, so the dropdown next to Export (which picks
  // the target for discovery) looked like a filter and did nothing. This one
  // is the filter (2026-09-02).
  function setWorkspace(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("workspace", value);
    else params.delete("workspace");
    router.push(`/backlinks?${params.toString()}`);
  }

  function setFilter(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set("status", value);
    } else {
      params.delete("status");
    }
    router.push(`/backlinks?${params.toString()}`);
  }

  const currentQuery = searchParams.get("q") ?? "";

  function setQuery(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set("q", value);
    } else {
      params.delete("q");
    }
    // `replace`, not `push`: typing should not fill the back button with a
    // history entry per keystroke.
    router.replace(`/backlinks?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-2 mb-4 flex-wrap">
      <SearchInput
        placeholder="Search backlinks…"
        className="flex-1 max-w-[320px]"
        value={currentQuery}
        onChange={setQuery}
      />
      {TAB_CHIPS.map((c) => (
        <Chip
          key={c.label}
          label={c.label}
          active={currentStatus === c.value}
          onClick={() => setFilter(c.value)}
        />
      ))}
      {workspaces.length > 1 && (
        <select
          value={currentWorkspace}
          onChange={(e) => setWorkspace(e.target.value)}
          aria-label="Filter by workspace"
          className="ml-auto h-8 rounded-lg border border-line bg-panel px-2 text-[12.5px] text-ink"
        >
          <option value="">All workspaces</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}
