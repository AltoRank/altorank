import { PageHead } from "@/components/ui";
import { ActionSkeleton, CardSkeleton, PageBodySkeleton, StatStripSkeleton, SubtitleSkeleton, TableSkeleton } from "@/components/ui/skeleton";

/**
 * Two faults, both of them the skeleton describing a page that does not exist.
 *
 * The columns were `["Prompt", "Engine", "Named", "Cited", "Named instead"]`,
 * a table `/geo` has never rendered. Its two tables are "By answer engine"
 * (`geo/page.tsx:172`) and "Who gets cited instead" (`:215`); the prompt set
 * below them is a stack of bordered rows, not a table at all.
 *
 * And the body was `flex flex-col gap-5`, which `geo/page.tsx:119-127` spends
 * nine lines explaining it must not be: a flex column inside a fixed-height
 * scroll container shrinks its children, and every Card there is
 * `overflow-hidden`, so the shrink clipped them rather than scrolling. The
 * skeleton reintroduced the bug the page documents fixing.
 */
export default function GeoLoading() {
  return (
    <>
      <PageHead title="AI visibility" subtitle={<SubtitleSkeleton width="w-72" />} actions={<ActionSkeleton width="w-28" />} />
      <StatStripSkeleton count={4} />
      <PageBodySkeleton label="Loading AI visibility" className="space-y-5">
        <CardSkeleton title="What to do about it" lines={3} />
        <TableSkeleton columns={["Engine", "Answers", "Mentioned", "Cited"]} numericFrom={1} rows={4} />
        <TableSkeleton columns={["Domain", "Citations", "Share of voice"]} numericFrom={1} rows={5} />
      </PageBodySkeleton>
    </>
  );
}
