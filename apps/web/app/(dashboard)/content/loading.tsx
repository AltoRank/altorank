import { PageHead } from "@/components/ui";
import { ActionSkeleton, CalendarSkeleton, PageBodySkeleton, Skeleton, SubtitleSkeleton } from "@/components/ui/skeleton";

/**
 * The month grid before its entries. The title names the current month, which
 * is what the page shows unless the reader has paged to another one; the
 * calendar controls row and the seven-column grid are drawn at their real
 * size so the entries land in cells that already exist.
 */
export default function ContentLoading() {
  const month = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return (
    <>
      <PageHead title={`${month} plan`} subtitle={<SubtitleSkeleton width="w-72" />} actions={<ActionSkeleton width="w-32" />} />
      <PageBodySkeleton label="Loading the content plan">
        <div className="mb-4 flex items-center gap-3">
          <Skeleton className="h-7 w-7 rounded-[7px]" />
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-7 w-7 rounded-[7px]" />
          <div className="ml-auto flex gap-2">
            <Skeleton className="h-[30px] w-44 rounded-[7px]" />
            <Skeleton className="h-[30px] w-28 rounded-[7px]" />
            <Skeleton className="h-[30px] w-36 rounded-[7px]" />
          </div>
        </div>
        <CalendarSkeleton weeks={5} filled={8} />
      </PageBodySkeleton>
    </>
  );
}
