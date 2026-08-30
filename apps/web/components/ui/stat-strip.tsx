import { cn } from "@/lib/utils";

type Stat = {
  label: string;
  value: string | number;
  unit?: string;
  delta?: string;
  deltaType?: "pos" | "neg" | "neutral";
};

export function StatStrip({ stats, cols = 4 }: { stats: Stat[]; cols?: number }) {
  return (
    <div
      className="grid gap-px bg-line border-b border-line"
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
    >
      {stats.map((s) => (
        <div key={s.label} className="bg-bg px-6 py-4">
          <div className="font-mono text-[10.5px] font-medium text-ink-3 uppercase tracking-[0.06em] mb-1.5">
            {s.label}
          </div>
          <div className="text-[22px] font-semibold tracking-tight text-ink">
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
