import type { CoverageBucket } from "@/lib/gsc/analysis";

/**
 * The index-coverage pill, on its own so a client component (the Articles
 * history table) can draw it without pulling in gsc-blocks.tsx, which reads
 * vercel.json for the sync clock. The dashboard blocks re-export it.
 */
export const COVERAGE_LABEL: Record<CoverageBucket, string> = {
  indexed: "Indexed",
  not_indexed: "Not indexed",
  unknown: "Unknown",
};

export function IndexBadge({ bucket, title }: { bucket: CoverageBucket; title?: string }) {
  const cls =
    bucket === "indexed"
      ? "bg-ok-soft text-ok-ink"
      : bucket === "not_indexed"
        ? "bg-warn-soft text-warn-ink"
        : "border border-line text-ink-3";
  return (
    <span className={`inline-flex items-center px-[7px] py-px rounded-full text-[11px] font-medium whitespace-nowrap ${cls}`} title={title}>
      {COVERAGE_LABEL[bucket]}
    </span>
  );
}
