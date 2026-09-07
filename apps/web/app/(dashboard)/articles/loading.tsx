import { PageHead } from "@/components/ui";
import { ActionSkeleton, FilterRowSkeleton, PageBodySkeleton, Skeleton, StatStripSkeleton, SubtitleSkeleton, TableSkeleton } from "@/components/ui/skeleton";

/** Four stats, search and status tabs, then the history table with its real columns. */
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
          <FilterRowSkeleton chips={5} className="mb-0 ml-auto" />
        </div>
        <TableSkeleton columns={["Image", "Title", "Keyword", "Difficulty", "Volume", "Clicks /30d", "Index", "Status", "Date", ""]} rows={8} />
      </PageBodySkeleton>
    </>
  );
}
