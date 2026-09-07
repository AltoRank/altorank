import { PageHead } from "@/components/ui";
import { ActionSkeleton, CardGridSkeleton, PageBodySkeleton, SubtitleSkeleton } from "@/components/ui/skeleton";

/**
 * The integration groups in the order the page lists them, each a row of
 * tiles.
 *
 * The labels are constants, so they are text. The *counts* were not: this
 * listed `[["CMS", 4], ["Analytics", 3], ["Data", 2]]`, which asserted three
 * numbers, all of them wrong against the seeded catalogue, and skipped Notify
 * and Automate entirely - `connect/page.tsx:20` iterates five groups. Nothing
 * here knows how many tiles a group has before the read, so every group gets
 * the same handful of placeholders and none of them claims a total; that is
 * the rule `components/ui/skeleton.tsx` opens with.
 */
const GROUPS = ["CMS", "Analytics", "Data", "Notify", "Automate"];

/** Enough tiles to read as a row, few enough to promise nothing. */
const TILES_PER_GROUP = 3;

export default function ConnectLoading() {
  return (
    <>
      <PageHead title="Integrations" subtitle={<SubtitleSkeleton width="w-80" />} actions={<ActionSkeleton width="w-36" />} />
      <PageBodySkeleton label="Loading integrations">
        {GROUPS.map((label) => (
          <div key={label} className="mb-7">
            <h2 className="text-[13px] font-mono uppercase tracking-[0.08em] text-ink-3 mb-3">{label}</h2>
            <CardGridSkeleton count={TILES_PER_GROUP} />
          </div>
        ))}
      </PageBodySkeleton>
    </>
  );
}
