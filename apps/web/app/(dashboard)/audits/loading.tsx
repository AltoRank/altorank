import { PageHead } from "@/components/ui";
import { ActionSkeleton, PageBodySkeleton, Skeleton, StatStripSkeleton, SubtitleSkeleton, TableSkeleton } from "@/components/ui/skeleton";

export default function AuditsLoading() {
  return (
    <>
      <PageHead title="Site audits" subtitle={<SubtitleSkeleton width="w-56" />} />
      <StatStripSkeleton count={4} />
      <PageBodySkeleton label="Loading audits">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Skeleton className="h-6 w-6 rounded-[6px]" />
            <Skeleton className="h-3.5 w-32" />
          </div>
          <ActionSkeleton width="w-24" />
        </div>
        <TableSkeleton columns={["Date", "Score", "Pages", "Issues", "Status"]} rows={4} numericFrom={1} />
      </PageBodySkeleton>
    </>
  );
}
