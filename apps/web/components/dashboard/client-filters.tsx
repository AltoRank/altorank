"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Chip, SearchInput } from "@/components/ui";

const STATUS_CHIPS = [
  { label: "All", value: "" },
  { label: "Publishing", value: "on" },
  { label: "Review", value: "review" },
  { label: "Paused", value: "paused" },
];

export function ClientFilters() {
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
    router.push(`/clients?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-2 mb-4 flex-wrap">
      <SearchInput placeholder="Search clients…" className="flex-1 max-w-[320px]" />
      {STATUS_CHIPS.map((c) => (
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
