import { PageHead } from "@/components/ui";
import { ActionSkeleton, CardGridSkeleton, PageBodySkeleton, SubtitleSkeleton } from "@/components/ui/skeleton";

/**
 * The integration groups in the order the page lists them, each a row of
 * tiles. The group labels are constants, so they are text; the tiles are not.
 */
const GROUPS: [string, number][] = [
  ["CMS", 4],
  ["Analytics", 3],
  ["Data", 2],
];

export default function ConnectLoading() {
  return (
    <>
      <PageHead title="Integrations" subtitle={<SubtitleSkeleton width="w-80" />} actions={<ActionSkeleton width="w-36" />} />
      <PageBodySkeleton label="Loading integrations">
        {GROUPS.map(([label, count]) => (
          <div key={label} className="mb-7">
            <h2 className="text-[13px] font-mono uppercase tracking-[0.08em] text-ink-3 mb-3">{label}</h2>
            <CardGridSkeleton count={count} />
          </div>
        ))}
      </PageBodySkeleton>
    </>
  );
}
