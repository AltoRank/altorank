import { PageHead } from "@/components/ui";
import { ActionSkeleton, CardSkeleton, PageBodySkeleton, Skeleton, SubtitleSkeleton, TableSkeleton } from "@/components/ui/skeleton";

/**
 * The two cards LinkingConfig draws - sources, then the pages we link to -
 * with their real columns.
 *
 * Both tables used to sit under bare `<h3>`s rather than inside cards, so
 * every row landed about a card header lower once the data arrived. And the
 * subtitle was the literal sentence "Configure how we find links on your
 * website for internal linking", which `linking/page.tsx:46-48` records
 * deleting: the real subtitle is the bare domain in mono, which nothing knows
 * before the read.
 */
export default function LinkingLoading() {
  return (
    <>
      <PageHead title="Linking" subtitle={<SubtitleSkeleton width="w-40" />} />
      <PageBodySkeleton label="Loading the linking configuration" className="flex flex-col gap-6">
        <CardSkeleton
          className="shrink-0"
          title="Sources"
          flush
          meta={
            <div className="flex items-center gap-2">
              <ActionSkeleton width="w-28" />
              <ActionSkeleton width="w-28" />
            </div>
          }
        >
          <TableSkeleton columns={["Kind", "URL", "Pages found", "Last detected", ""]} rows={3} />
        </CardSkeleton>
        <CardSkeleton
          className="shrink-0"
          title="Pages we link to"
          flush
          meta={
            <div className="flex items-center gap-3">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-[34px] w-[220px] rounded-[7px]" />
            </div>
          }
        >
          <TableSkeleton columns={["Page", "Keyword", "Priority", "Anchors", "Enabled"]} rows={6} />
        </CardSkeleton>
      </PageBodySkeleton>
    </>
  );
}
