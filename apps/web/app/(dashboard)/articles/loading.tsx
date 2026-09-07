import { PageHead } from "@/components/ui";
import { ActionSkeleton, FilterRowSkeleton, PageBodySkeleton, Skeleton, StatStripSkeleton, SubtitleSkeleton, TableSkeleton } from "@/components/ui/skeleton";

/**
 * Four stats, search and status chips, then the history table with its real
 * columns.
 *
 * Three things were off. The chip row had five where `HISTORY_FILTERS` has six
 * (All, In review, Approved, Scheduled, Live, Archived). The "Image" column
 * was unconditional, though the page renders it only when some article has an
 * image (`article-history.tsx:81`), so in the common case every column shifted
 * one place as the data landed - the exact reflow a page-shaped skeleton is
 * for. And nothing was right-aligned, though the page right-aligns Difficulty,
 * Volume, Clicks /30d and Date.
 *
 * The Image column is left out here for the same reason it is conditional
 * there: a skeleton may under-promise, but a column that vanishes is a jump.
 */
export default function ArticlesLoading() {
  return (
    <>
      <PageHead
        title="Articles"
        subtitle={<SubtitleSkeleton width="w-44" />}
        actions={
          <>
            <ActionSkeleton width="w-28" />
            <ActionSkeleton width="w-24" />
            <ActionSkeleton width="w-28" />
          </>
        }
      />
      <StatStripSkeleton count={4} />
      <PageBodySkeleton label="Loading articles">
        <div className="mb-4 flex items-center gap-3">
          <Skeleton className="h-[34px] w-80 rounded-[7px]" />
          <FilterRowSkeleton chips={6} className="mb-0 ml-auto" />
        </div>
        <TableSkeleton columns={["Title", "Keyword", "Difficulty", "Volume", "Clicks /30d", "Index", "Status", "Date", ""]} numeric={[2, 3, 4, 7]} rows={8} />
      </PageBodySkeleton>
    </>
  );
}
