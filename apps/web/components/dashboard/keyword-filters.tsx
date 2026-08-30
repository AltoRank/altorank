"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Chip, SearchInput, Button, Icons } from "@/components/ui";

const STATUS_CHIPS = [
  { label: "All", value: "" },
  { label: "New", value: "new" },
  { label: "Planned", value: "planned" },
  { label: "Shipped", value: "shipped" },
];

const INTENT_OPTIONS = [
  { label: "All intents", value: "" },
  { label: "Info", value: "info" },
  { label: "Commercial", value: "commercial" },
  { label: "Transactional", value: "transactional" },
  { label: "Navigational", value: "navigational" },
];

export function KeywordFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentStatus = searchParams.get("status") ?? "";
  const currentIntent = searchParams.get("intent") ?? "";

  function setFilter(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    router.push(`/keywords?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-2 mb-4 flex-wrap">
      <SearchInput placeholder="Search keywords…" className="flex-1 max-w-[320px]" />
      {STATUS_CHIPS.map((c) => (
        <Chip
          key={c.label}
          label={c.label}
          active={currentStatus === c.value}
          onClick={() => setFilter("status", c.value)}
        />
      ))}
      <div className="flex-1" />
      {INTENT_OPTIONS.map((c) => (
        <Chip
          key={c.label}
          label={c.label}
          active={currentIntent === c.value}
          onClick={() => setFilter("intent", c.value)}
          soft={currentIntent !== c.value}
        />
      ))}
    </div>
  );
}
