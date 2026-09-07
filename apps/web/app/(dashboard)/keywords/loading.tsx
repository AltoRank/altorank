import { PageHead } from "@/components/ui";
import { ActionSkeleton, FilterRowSkeleton, PageBodySkeleton, Skeleton, StatStripSkeleton, SubtitleSkeleton, TableSkeleton } from "@/components/ui/skeleton";

/**
 * Four stats, the search-and-chips row with its Plan / Ranking switch, then
 * the plan table.
 *
 * The filter row drew six chips against the real row's twelve: five
 * `STATUS_CHIPS`, the two view chips, and five `INTENT_OPTIONS` that had no
 * placeholder at all (`components/dashboard/keyword-filters.tsx:6-20`). The
 * row is what reflows most on this page, so under-drawing it by half is the
 * one mismatch a reader actually sees.
 *
 * Five actions, not four: How it works, Export CSV, Add keyword, Playbooks and
 * Research keywords.
 */
export default function KeywordsLoading() {
  return (
    <>
      <PageHead
        title="Keywords"
        subtitle={<SubtitleSkeleton width="w-52" />}
        actions={
          <>
            <ActionSkeleton width="w-28" />
            <ActionSkeleton width="w-24" />
            <ActionSkeleton width="w-28" />
            <ActionSkeleton width="w-24" />
            <ActionSkeleton width="w-32" />
          </>
        }
      />
      <StatStripSkeleton count={4} />
      <PageBodySkeleton label="Loading keywords">
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          <Skeleton className="h-[34px] w-80 rounded-[7px]" />
          <FilterRowSkeleton chips={5} className="mb-0" />
          <div className="flex-1" />
          <FilterRowSkeleton chips={2} className="mb-0" />
          <FilterRowSkeleton chips={5} className="mb-0" />
        </div>
        <TableSkeleton columns={["Keyword", "Intent", "Volume", "Difficulty", "Status", ""]} rows={8} numeric={[2]} />
      </PageBodySkeleton>
    </>
  );
}
