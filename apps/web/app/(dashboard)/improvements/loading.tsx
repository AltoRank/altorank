import { PageHead } from "@/components/ui";
import { CardSkeleton, FilterRowSkeleton, PageBodySkeleton, SubtitleSkeleton, TableSkeleton } from "@/components/ui/skeleton";

/** The status tabs, the rewrites table and the candidates card, in the view's order. */
export default function ImprovementsLoading() {
  return (
    <>
      <PageHead title="Improvements" subtitle={<SubtitleSkeleton width="w-56" />} />
      <FilterRowSkeleton chips={4} className="mb-0 px-8 py-2.5 border-b border-line" />
      <PageBodySkeleton label="Loading improvements" className="space-y-5">
        <CardSkeleton title="Rewrites" lines={2} />
        <TableSkeleton columns={["Article", "Opportunity", "Status", "Changes", "Generated"]} rows={5} />
        <CardSkeleton title="Candidates" lines={3} />
      </PageBodySkeleton>
    </>
  );
}
