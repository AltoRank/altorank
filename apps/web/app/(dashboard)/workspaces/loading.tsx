import { PageHead } from "@/components/ui";
import { ActionSkeleton, FilterRowSkeleton, PageBodySkeleton, Skeleton, SubtitleSkeleton, TableSkeleton } from "@/components/ui/skeleton";

/**
 * Two things the roster has that this did not draw: a search box before the
 * status chips (`components/dashboard/client-filters.tsx:44`), and a sixth
 * column for the Pause/Resume control - headerless on the page, but a real
 * `<th>` with an sr-only "Actions" (`workspaces/page.tsx:85`). Five columns
 * against six is a table that re-lays itself out the moment the rows land.
 */
export default function WorkspacesLoading() {
  return (
    <>
      <PageHead title="Workspaces" subtitle={<SubtitleSkeleton width="w-48" />} actions={<ActionSkeleton width="w-32" />} />
      <PageBodySkeleton label="Loading workspaces">
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          <Skeleton className="h-[34px] w-80 rounded-[7px]" />
          <FilterRowSkeleton chips={4} className="mb-0" />
        </div>
        <TableSkeleton columns={["Workspace", "Status", "Articles", "Traffic /mo", "Authority", ""]} rows={5} numeric={[2, 3, 4]} />
      </PageBodySkeleton>
    </>
  );
}
