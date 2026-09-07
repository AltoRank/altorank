import { PageHeadSkeleton, Skeleton, SkeletonSoft } from "@/components/ui/skeleton";

/** The review bar and a column of proposed changes, the shape ReviewExecution renders. */
export default function ReviewExecutionLoading() {
  return (
    <>
      <PageHeadSkeleton back titleWidth="w-72" />
      <div role="status" aria-busy="true" aria-label="Loading the rewrite" className="flex-1 min-h-0 flex flex-col">
        <span className="sr-only">Loading the rewrite</span>
        <div className="px-8 py-2.5 border-b border-line bg-bg flex items-center gap-3">
          <Skeleton className="h-3 w-40" />
          <SkeletonSoft className="h-3 w-56" />
          <Skeleton className="ml-auto h-[30px] w-32 rounded-[7px]" />
        </div>
        <div className="flex-1 overflow-y-auto px-8 py-6">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="grid md:grid-cols-[120px_1fr_1fr_auto] gap-3 items-start px-3 py-3 border-b border-line-soft">
              <SkeletonSoft className="h-3 w-20" />
              <div>
                <Skeleton className="h-3 w-full" />
                <SkeletonSoft className="mt-2 h-3 w-4/5" />
              </div>
              <div>
                <Skeleton className="h-3 w-full" />
                <SkeletonSoft className="mt-2 h-3 w-3/5" />
              </div>
              <Skeleton className="h-7 w-20 rounded-[7px]" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
