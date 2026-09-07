import { FilterRowSkeleton, PageBodySkeleton, PageHeadSkeleton, StatStripSkeleton, TableSkeleton } from "@/components/ui/skeleton";

/** Head, four stats, the tab row, then the first tab's article table. */
export default function WorkspaceDetailLoading() {
  return (
    <>
      <PageHeadSkeleton back titleWidth="w-48" />
      <StatStripSkeleton count={4} />
      <FilterRowSkeleton chips={5} className="mb-0 px-8 py-2.5 border-b border-line" />
      <PageBodySkeleton label="Loading the workspace">
        <TableSkeleton columns={["Article", "Keyword", "Status", "Score", "Vol /mo", "Position", "Updated"]} rows={6} numericFrom={3} />
      </PageBodySkeleton>
    </>
  );
}
