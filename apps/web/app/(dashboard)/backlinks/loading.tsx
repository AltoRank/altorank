import { PageHead } from "@/components/ui";
import { ActionSkeleton, FilterRowSkeleton, PageBodySkeleton, Skeleton, StatStripSkeleton, SubtitleSkeleton, TableSkeleton } from "@/components/ui/skeleton";

/**
 * Five stats, the filter row, then the links table with its real columns.
 *
 * `compact` matters: `backlinks/page.tsx:91` renders `<StatStrip compact>`,
 * which is `px-4 py-2.5` with no delta line against the default's `px-6 py-4`
 * with one, so without it here the whole strip visibly shrank when the data
 * landed. Five chips, not four (`backlink-filters.tsx:11-17`), and four
 * actions, not two: How it works, Export CSV, Freshness and the exchange form.
 */
export default function BacklinksLoading() {
  return (
    <>
      <PageHead
        title="Backlinks"
        subtitle={<SubtitleSkeleton width="w-64" />}
        actions={
          <>
            <ActionSkeleton width="w-28" />
            <ActionSkeleton width="w-24" />
            <ActionSkeleton width="w-32" />
            <ActionSkeleton width="w-28" />
          </>
        }
      />
      <StatStripSkeleton count={5} compact />
      <PageBodySkeleton label="Loading backlinks">
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          <Skeleton className="h-[34px] w-80 rounded-[7px]" />
          <FilterRowSkeleton chips={5} className="mb-0" />
        </div>
        <TableSkeleton columns={["From", "DR", "Anchor", "To", "Link", "First seen", "Status"]} rows={6} numeric={[1, 5]} />
      </PageBodySkeleton>
    </>
  );
}
