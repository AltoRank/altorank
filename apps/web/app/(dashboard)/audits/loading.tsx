import { PageHead } from "@/components/ui";
import { ActionSkeleton, PageBodySkeleton, StatStripSkeleton, SubtitleSkeleton, TableSkeleton } from "@/components/ui/skeleton";

/**
 * `numeric={[1, 2, 3]}` right-aligned Status along with Score, Pages and Issues;
 * the page right-aligns only the three numbers (`audits/page.tsx:116`). And
 * the avatar-and-name row was unconditional, though the page draws it only for
 * a merged view and otherwise puts the button alone on the right
 * (`audits/page.tsx:103`) - so the scoped case, which is the normal one, was
 * promised two elements that never arrived.
 */
export default function AuditsLoading() {
  return (
    <>
      <PageHead title="Site audits" subtitle={<SubtitleSkeleton width="w-56" />} />
      <StatStripSkeleton count={4} />
      <PageBodySkeleton label="Loading audits">
        <div className="mb-3 flex items-center justify-end">
          <ActionSkeleton width="w-24" />
        </div>
        <TableSkeleton columns={["Date", "Score", "Pages", "Issues", "Status"]} rows={4} numericFrom={1} />
      </PageBodySkeleton>
    </>
  );
}
