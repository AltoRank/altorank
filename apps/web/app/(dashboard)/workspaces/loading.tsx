import { PageHead } from "@/components/ui";
import { ActionSkeleton, FilterRowSkeleton, PageBodySkeleton, SubtitleSkeleton, TableSkeleton } from "@/components/ui/skeleton";

export default function WorkspacesLoading() {
  return (
    <>
      <PageHead title="Workspaces" subtitle={<SubtitleSkeleton width="w-48" />} actions={<ActionSkeleton width="w-32" />} />
      <PageBodySkeleton label="Loading workspaces">
        <FilterRowSkeleton chips={4} />
        <TableSkeleton columns={["Workspace", "Status", "Articles", "Traffic /mo", "Authority"]} rows={5} numericFrom={2} />
      </PageBodySkeleton>
    </>
  );
}
