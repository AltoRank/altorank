import { PageHead } from "@/components/ui";
import { ActionSkeleton, CardSkeleton, PageBodySkeleton, StatStripSkeleton, SubtitleSkeleton, TableSkeleton } from "@/components/ui/skeleton";

export default function GeoLoading() {
  return (
    <>
      <PageHead title="AI visibility" subtitle={<SubtitleSkeleton width="w-72" />} actions={<ActionSkeleton width="w-28" />} />
      <StatStripSkeleton count={4} />
      <PageBodySkeleton label="Loading AI visibility" className="flex flex-col gap-5">
        <CardSkeleton title="What to do about it" lines={3} />
        <TableSkeleton columns={["Prompt", "Engine", "Named", "Cited", "Named instead"]} rows={5} />
      </PageBodySkeleton>
    </>
  );
}
