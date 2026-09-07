import { PageHead } from "@/components/ui";
import { ActionSkeleton, FilterRowSkeleton, PageBodySkeleton, Skeleton, StatStripSkeleton, SubtitleSkeleton, TableSkeleton } from "@/components/ui/skeleton";

/** Five stats, the filter row, then the links table with its real columns. */
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
          </>
        }
      />
      <StatStripSkeleton count={5} />
      <PageBodySkeleton label="Loading backlinks">
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          <Skeleton className="h-[34px] w-80 rounded-[7px]" />
          <FilterRowSkeleton chips={4} className="mb-0" />
        </div>
        <TableSkeleton columns={["From", "DR", "Anchor", "To", "Link", "First seen", "Status"]} rows={6} numeric={[1, 5]} />
      </PageBodySkeleton>
    </>
  );
}
