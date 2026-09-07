import { PageHead } from "@/components/ui";
import { ActionSkeleton, PageBodySkeleton, Skeleton, TableSkeleton } from "@/components/ui/skeleton";

/** The two cards LinkingConfig draws - sources, then the pages we link to - with their real columns. */
export default function LinkingLoading() {
  return (
    <>
      <PageHead
        title="Linking configuration"
        subtitle={
          <span>
            Configure how we find links on your website for internal linking. <Skeleton className="inline-block h-3 w-28 align-middle" />
          </span>
        }
      />
      <PageBodySkeleton label="Loading the linking configuration" className="flex flex-col gap-6">
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="m-0 text-sm font-semibold tracking-[-0.005em]">Sources</h3>
            <ActionSkeleton width="w-28" />
          </div>
          <TableSkeleton columns={["Kind", "URL", "Pages found", "Last detected", ""]} rows={3} />
        </section>
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="m-0 text-sm font-semibold tracking-[-0.005em]">Pages we link to</h3>
            <Skeleton className="h-3 w-24" />
          </div>
          <TableSkeleton columns={["Page", "Keyword", "Priority", "Anchors", "Enabled"]} rows={6} />
        </section>
      </PageBodySkeleton>
    </>
  );
}
