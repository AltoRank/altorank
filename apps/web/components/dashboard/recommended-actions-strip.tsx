import Link from "next/link";
import { Button } from "@/components/ui";
import type { RecommendedAction } from "@/lib/dashboard/recommended-actions";
import { PlanMonthButton } from "./plan-month-button";

/**
 * State-driven cards, each naming what is undone and what that costs. Server
 * component: the only interactive card (Plan) delegates to its own button.
 */
export function RecommendedActionsStrip({ actions }: { actions: RecommendedAction[] }) {
  if (actions.length === 0) return null;
  return (
    <section aria-label="Recommended actions" className="mb-4">
      <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3 mb-2">Recommended actions</div>
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(actions.length, 4)}, minmax(0, 1fr))` }}>
        {actions.map((a) => (
          <div key={a.id} className="rounded-[10px] border border-line bg-bg px-4 py-3.5 flex flex-col gap-2">
            <div className="text-[13.5px] font-medium text-ink">{a.title}</div>
            <p className="text-[12.5px] text-ink-3 leading-[1.55] flex-1">{a.consequence}</p>
            <div>
              {a.run === "plan" ? (
                <PlanMonthButton label={a.cta} size="sm" />
              ) : (
                <Link href={a.href ?? "#"}>
                  <Button size="sm">{a.cta}</Button>
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
