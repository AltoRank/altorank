import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Stat = {
  label: string;
  value: string | number;
  unit?: string;
  delta?: ReactNode;
  deltaType?: "pos" | "neg" | "neutral";
  /**
   * Where the number comes from. Every figure in this product is measured by
   * something specific, and a reader who cannot tell an estimate from a count
   * is right not to trust either (2026-09-02).
   */
  hint?: string;
};

/**
 * `cols` defaults to the number of stats, so five no longer wrap onto a second
 * row with three empty cells beside them. `compact` halves the padding for
 * strips that are context rather than the page's subject.
 */
export function StatStrip({ stats, cols, compact = false }: { stats: Stat[]; cols?: number; compact?: boolean }) {
  const columns = cols ?? stats.length;
  return (
    <div
      className="grid gap-px bg-line border-b border-line"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {stats.map((s) => (
        <div key={s.label} className={cn("bg-bg", compact ? "px-4 py-2.5" : "px-6 py-4")}>
          <div className="font-mono text-[10.5px] font-medium text-ink-3 uppercase tracking-[0.06em] mb-1.5 truncate">
            {s.hint ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help border-b border-dotted border-line-soft">{s.label}</span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[280px]">{s.hint}</TooltipContent>
              </Tooltip>
            ) : (
              s.label
            )}
          </div>
          <div className={cn("font-semibold tracking-tight text-ink", compact ? "text-[18px]" : "text-[22px]")}>
            {s.value}
            {s.unit && <span className="text-[13px] font-normal text-ink-3 ml-0.5">{s.unit}</span>}
          </div>
          {s.delta && (
            <div
              className={cn(
                "text-[11.5px] mt-1 font-mono inline-flex items-center gap-1",
                s.deltaType === "pos" && "text-ok-ink",
                s.deltaType === "neg" && "text-err-ink",
                !s.deltaType || s.deltaType === "neutral" ? "text-ink-3" : ""
              )}
            >
              {s.delta}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
