import { PageHeadSkeleton, Skeleton, SkeletonSoft } from "@/components/ui/skeleton";

/** The editor's three columns - outline, body, sidebar - at the widths ArticleEditor uses. */
export default function ArticleEditorLoading() {
  return (
    <>
      <PageHeadSkeleton back titleWidth="w-80" />
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading the article"
        className="flex-1 grid min-h-0 min-w-[960px] md:min-w-0"
        style={{ gridTemplateColumns: "280px 1fr 340px" }}
      >
        <span className="sr-only">Loading the article</span>
        <div className="border-r border-line p-5">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <SkeletonSoft key={i} className={i === 0 ? "h-3 w-3/4" : "mt-3 h-3 w-2/3"} />
          ))}
        </div>
        <div className="border-r border-line flex flex-col min-h-0">
          <div className="flex gap-1 items-center px-6 py-2.5 border-b border-line">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-6 w-6 rounded-[6px]" />
            ))}
            <div className="ml-auto flex gap-2">
              <Skeleton className="h-[28px] w-16 rounded-[7px]" />
              <Skeleton className="h-[28px] w-24 rounded-[7px]" />
            </div>
          </div>
          <div className="px-10 py-8">
            <Skeleton className="h-7 w-3/4" />
            {Array.from({ length: 10 }, (_, i) => (
              <SkeletonSoft key={i} className={`mt-3 h-3 ${i % 4 === 3 ? "w-1/2" : "w-full"}`} />
            ))}
          </div>
        </div>
        <aside className="bg-panel p-5">
          {[0, 1, 2].map((s) => (
            <div key={s} className={s > 0 ? "mt-6" : undefined}>
              <SkeletonSoft className="h-2.5 w-24" />
              <Skeleton className="mt-3 h-3 w-full" />
              <Skeleton className="mt-2 h-3 w-4/5" />
            </div>
          ))}
        </aside>
      </div>
    </>
  );
}
