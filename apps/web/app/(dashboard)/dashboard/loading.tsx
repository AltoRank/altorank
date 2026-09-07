import { PageHead } from "@/components/ui";
import {
  ActionSkeleton,
  CardSkeleton,
  PageBodySkeleton,
  Skeleton,
  SkeletonSoft,
  StatStripSkeleton,
  SubtitleSkeleton,
} from "@/components/ui/skeleton";

/** Five stats, the recommended-actions strip, then the 8/4 and 7/5 card rows the page draws. */
export default function DashboardLoading() {
  return (
    <>
      <PageHead
        title="Dashboard"
        subtitle={<SubtitleSkeleton width="w-56" />}
        actions={
          <>
            <ActionSkeleton width="w-28" />
            <ActionSkeleton width="w-36" />
          </>
        }
      />
      <StatStripSkeleton count={5} />
      <PageBodySkeleton label="Loading the dashboard">
        <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">Recommended actions</div>
        <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg border border-line bg-bg p-4">
              <Skeleton className="h-3.5 w-40" />
              <SkeletonSoft className="mt-3 h-2.5 w-full" />
              <SkeletonSoft className="mt-1.5 h-2.5 w-3/4" />
              <Skeleton className="mt-4 h-[30px] w-20 rounded-[7px]" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
          <CardSkeleton title="Search performance" className="md:col-span-8">
            <Skeleton className="h-[220px] w-full rounded-[7px]" />
          </CardSkeleton>
          <CardSkeleton title="Needs your review" className="md:col-span-4" lines={4} />
          <CardSkeleton title="Best articles" className="md:col-span-7" lines={4} />
          <CardSkeleton title="Index coverage" className="md:col-span-5" lines={3} />
        </div>
      </PageBodySkeleton>
    </>
  );
}
