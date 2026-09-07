import { PageHead } from "@/components/ui";
import { ActionSkeleton, PageBodySkeleton, TableSkeleton } from "@/components/ui/skeleton";

/** The subtitle is a constant on the real page, so it is text here too. */
export default function ReportsLoading() {
  return (
    <>
      <PageHead
        title="Reports"
        subtitle={<span>Monthly PDF reports, in your accent colour</span>}
        actions={<ActionSkeleton width="w-36" />}
      />
      <PageBodySkeleton label="Loading reports">
        <TableSkeleton columns={["Period", "Articles", "Traffic", "Keywords", "Status", ""]} rows={4} numeric={[1, 2, 3]} />
      </PageBodySkeleton>
    </>
  );
}
