import { PageHead } from "@/components/ui";
import { ActionSkeleton, CardSkeleton, FilterRowSkeleton, PageBodySkeleton, SubtitleSkeleton, TableSkeleton } from "@/components/ui/skeleton";

/**
 * The technical-issues card, the rewrites table and the candidates card, in
 * the view's order.
 *
 * The rewrites table used to sit *below* a `CardSkeleton title="Rewrites"`
 * rather than inside it, so the page drew one box where this drew two, and
 * every row landed a card header lower. `TechnicalIssues` - which is the first
 * thing on the page (`improvements-view.tsx:217`) and the only card that has
 * anything in it before Search Console is connected - had no placeholder at
 * all. The tab row also carries an "Analyze now" button on its right
 * (`improvements-view.tsx:153`).
 */
export default function ImprovementsLoading() {
  return (
    <>
      <PageHead title="Improvements" subtitle={<SubtitleSkeleton width="w-56" />} />
      <div className="flex items-center gap-2 px-8 py-2.5 border-b border-line">
        <FilterRowSkeleton chips={4} className="mb-0" />
        <div className="ml-auto">
          <ActionSkeleton width="w-28" />
        </div>
      </div>
      <PageBodySkeleton label="Loading improvements" className="space-y-5">
        <CardSkeleton title="Technical issues" lines={3} />
        <CardSkeleton title="Rewrites" flush>
          <TableSkeleton columns={["Article", "Opportunity", "Status", "Changes", "Generated"]} rows={5} numeric={[3, 4]} />
        </CardSkeleton>
        <CardSkeleton title="Candidates" lines={3} />
      </PageBodySkeleton>
    </>
  );
}
