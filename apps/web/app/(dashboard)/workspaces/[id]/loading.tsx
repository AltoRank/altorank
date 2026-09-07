import { CardGridSkeleton, FilterRowSkeleton, PageBodySkeleton, PageHeadSkeleton, StatStripSkeleton, TableSkeleton } from "@/components/ui/skeleton";

/**
 * Head, four stats, the tab row, then the Overview tab.
 *
 * It drew the Articles table, and its own docstring called that "the first
 * tab's article table" - but the first tab is Overview
 * (`client-tabs.tsx:41`), which is a four-up card grid, the first-draft card
 * and a headerless recent-articles table. The table this used to draw only
 * appears after a click, so the skeleton was standing in for a screen the
 * reader had not asked for.
 *
 * Seven tabs, not five (`client-tabs.tsx:31-37`), and the head carries a
 * Pause/Resume control (`workspaces/[id]/page.tsx:109`).
 */
export default function WorkspaceDetailLoading() {
  return (
    <>
      <PageHeadSkeleton back titleWidth="w-48" subtitleWidth="w-64" actions={1} />
      <StatStripSkeleton count={4} />
      <FilterRowSkeleton chips={7} className="mb-0 px-8 py-2.5 border-b border-line" />
      <PageBodySkeleton label="Loading the workspace" className="space-y-6">
        <CardGridSkeleton count={4} cols="grid-cols-2 md:grid-cols-4" />
        <TableSkeleton columns={["", "", "", ""]} rows={5} numeric={[3]} />
      </PageBodySkeleton>
    </>
  );
}
