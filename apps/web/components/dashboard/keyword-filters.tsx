"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Chip, SearchInput, Button, Icons } from "@/components/ui";

const STATUS_CHIPS = [
  { label: "All", value: "" },
  { label: "New", value: "new" },
  { label: "Stored", value: "stored" },
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

/**
 * `rankingAvailable` is false when no workspace is scoped: positions, clicks
 * and impressions belong to one site, and a table of them across several
 * would be numbers describing none of them.
 */
export function KeywordFilters({ rankingAvailable = false }: { rankingAvailable?: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentStatus = searchParams.get("status") ?? "";
  const currentIntent = searchParams.get("intent") ?? "";
  const currentView = searchParams.get("view") === "ranking" ? "ranking" : "plan";

  function setFilter(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    router.push(`/keywords?${params.toString()}`);
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
    router.replace(`/keywords?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-2 mb-4 flex-wrap">
      <SearchInput
        placeholder="Search keywords…"
        className="flex-1 max-w-[320px]"
        value={currentQuery}
        onChange={setQuery}
      />
      {STATUS_CHIPS.map((c) => (
        <Chip
          key={c.label}
          label={c.label}
          active={currentStatus === c.value}
          onClick={() => setFilter("status", c.value)}
        />
      ))}
      <div className="flex-1" />
      {rankingAvailable && (
        <div className="flex items-center gap-1 mr-2 pr-2 border-r border-line">
          <Chip label="Plan" active={currentView === "plan"} onClick={() => setFilter("view", "")} soft={currentView !== "plan"} />
          <Chip label="Ranking" active={currentView === "ranking"} onClick={() => setFilter("view", "ranking")} soft={currentView !== "ranking"} />
        </div>
      )}
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
