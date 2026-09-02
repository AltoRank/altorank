import { Card } from "@/components/ui/card";
import type { MetricPoint } from "@/lib/queries/metrics";

/**
 * Four numbers over time, drawn only where there is more than one measurement.
 *
 * A single point is a number, not a trend, and a line through one point is a
 * claim about a shape nobody observed. Until the second run exists, this shows
 * the value and says when it was taken.
 */
const SERIES = [
  { key: "authority", label: "Authority", hint: "DataForSEO backlink rank, 0-100" },
  { key: "traffic", label: "Organic visits", hint: "estimated, per month" },
  { key: "referring_domains", label: "Referring domains", hint: "sites linking here" },
  { key: "ranking_keywords", label: "Ranking keywords", hint: "terms found on the SERP" },
] as const;

function Spark({ values }: { values: number[] }) {
  const W = 220;
  const H = 40;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const x = (i: number) => (i * W) / Math.max(1, values.length - 1);
  const y = (v: number) => H - ((v - min) / span) * (H - 6) - 3;
  const path = values.map((v, i) => `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 h-[40px] w-full" preserveAspectRatio="none" aria-hidden="true">
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function MetricHistory({ points }: { points: MetricPoint[] }) {
  if (!points.length) return null;
  const last = points[points.length - 1];
  const measured = new Date(last.measured_on).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-ink">Measured over time</span>
        <span className="font-mono text-[11px] text-ink-3">
          {points.length === 1 ? `one measurement, ${measured}` : `${points.length} measurements to ${measured}`}
        </span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {SERIES.map((s) => {
          const values = points
            .map((p) => p[s.key])
            .filter((v): v is number => typeof v === "number");
          const current = typeof last[s.key] === "number" ? (last[s.key] as number) : null;
          const first = values[0];
          const delta = values.length > 1 && typeof current === "number" ? current - first : null;
          return (
            <div key={s.key}>
              <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">{s.label}</div>
              <div className="mt-0.5 flex items-baseline gap-2">
                <span className="font-mono text-[20px] font-semibold text-ink">
                  {current === null ? "—" : current.toLocaleString()}
                </span>
                {delta !== null && delta !== 0 && (
                  <span className={`font-mono text-[11.5px] ${delta > 0 ? "text-ok-ink" : "text-err-ink"}`}>
                    {delta > 0 ? "+" : ""}
                    {delta.toLocaleString()}
                  </span>
                )}
              </div>
              {values.length > 1 ? (
                <Spark values={values} />
              ) : (
                <div className="mt-2 h-[40px] text-[11px] leading-[40px] text-ink-3">{s.hint}</div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
