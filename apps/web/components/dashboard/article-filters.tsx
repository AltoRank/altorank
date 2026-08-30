"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Chip, SearchInput } from "@/components/ui";

const STATUS_CHIPS = [
  { label: "All", value: "" },
  { label: "Live", value: "live" },
  { label: "Review", value: "review" },
  { label: "Drafting", value: "drafting" },
  { label: "Scheduled", value: "scheduled" },
  { label: "Draft", value: "draft" },
];

export function ArticleFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentStatus = searchParams.get("status") ?? "";

  function setFilter(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    router.push(`/articles?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-2 mb-4 flex-wrap">
      <SearchInput placeholder="Search articles…" className="flex-1 max-w-[320px]" />
      {STATUS_CHIPS.map((c) => (
        <Chip
          key={c.label}
          label={c.label}
          active={currentStatus === c.value}
          onClick={() => setFilter("status", c.value)}
        />
      ))}
    </div>
  );
}
