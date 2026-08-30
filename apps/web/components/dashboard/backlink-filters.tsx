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

export function BacklinkFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentStatus = searchParams.get("status") ?? "";

  function setFilter(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set("status", value);
    } else {
      params.delete("status");
    }
    router.push(`/backlinks?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-2 mb-4 flex-wrap">
      <SearchInput placeholder="Search backlinks…" className="flex-1 max-w-[320px]" />
      {TAB_CHIPS.map((c) => (
        <Chip
          key={c.label}
          label={c.label}
          active={currentStatus === c.value}
          onClick={() => setFilter(c.value)}
        />
      ))}
    </div>
  );
}
